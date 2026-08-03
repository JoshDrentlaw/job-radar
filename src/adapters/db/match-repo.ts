import type { Sql } from "@platform/db.ts";
import type { BoardId, FacetId, PostingId } from "@platform/ids.ts";
import type { MatchCandidate, MatchRepo, ScoreRow, StalePair } from "@domain/discovery/matching.ts";

interface CandidateRow {
  posting_id: string;
  board_id: string;
  title: string;
  company_name: string;
  location_raw: string;
  currently_listed: boolean;
  first_seen_at: Date;
  provenance_fetched_at: Date;
  facet_id: string;
  facet_name: string;
  score: number;
  matched_chunk: string;
  scored_at: Date;
}

function toCandidate(row: CandidateRow): MatchCandidate {
  return {
    postingId: row.posting_id as PostingId,
    boardId: row.board_id as BoardId,
    title: row.title,
    companyName: row.company_name,
    locationRaw: row.location_raw,
    currentlyListed: row.currently_listed,
    firstSeenAt: row.first_seen_at,
    fetchedAt: row.provenance_fetched_at,
    facetId: row.facet_id as FacetId,
    facetName: row.facet_name,
    score: Number(row.score),
    matchedChunk: row.matched_chunk,
    scoredAt: row.scored_at,
  };
}

const CANDIDATE_SELECT = `
  m.posting_id, p.board_id, p.title, b.company_name, p.location_raw,
  p.currently_listed, p.first_seen_at, p.provenance_fetched_at,
  m.facet_id, f.name AS facet_name, m.score, pc.text AS matched_chunk, m.scored_at
`;

const CANDIDATE_FROM = `
  discovery.matches m
  JOIN discovery.postings p ON p.id = m.posting_id
  JOIN discovery.boards b ON b.id = p.board_id
  JOIN discovery.profile_facets f ON f.id = m.facet_id
  JOIN discovery.posting_chunks pc ON pc.id = m.posting_chunk_id
`;

export class PostgresMatchRepo implements MatchRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * Every (listed posting × active facet) whose match row is missing or was
   * scored from different content or a different model. Both sides must
   * already have fresh vectors — pairs still waiting on the embed drain are
   * not stale, they are not ready.
   */
  async stalePairs(model: string): Promise<StalePair[]> {
    const rows = await this.#sql<
      { posting_id: string; facet_id: string; posting_hash: string; facet_hash: string }[]
    >`
      SELECT p.id AS posting_id, f.id AS facet_id,
             p.provenance_content_hash AS posting_hash, f.content_hash AS facet_hash
      FROM discovery.postings p
      CROSS JOIN discovery.profile_facets f
      WHERE p.currently_listed AND f.active
        AND EXISTS (
          SELECT 1 FROM discovery.posting_chunks pc
          WHERE pc.posting_id = p.id AND pc.model = ${model}
            AND pc.content_hash = p.provenance_content_hash
        )
        AND EXISTS (
          SELECT 1 FROM discovery.facet_chunks fc
          WHERE fc.facet_id = f.id AND fc.model = ${model}
            AND fc.content_hash = f.content_hash
        )
        AND NOT EXISTS (
          SELECT 1 FROM discovery.matches m
          WHERE m.posting_id = p.id AND m.facet_id = f.id AND m.model = ${model}
            AND m.posting_content_hash = p.provenance_content_hash
            AND m.facet_content_hash = f.content_hash
        )
      ORDER BY p.first_seen_at, p.id, f.name
    `;
    return rows.map((r) => ({
      postingId: r.posting_id as PostingId,
      facetId: r.facet_id as FacetId,
      postingContentHash: r.posting_hash,
      facetContentHash: r.facet_hash,
    }));
  }

  /**
   * The best chunk pair, computed where the vectors live. `<=>` is pgvector's
   * cosine distance; similarity is 1 - distance.
   */
  async scorePair(pair: StalePair, model: string, at: Date): Promise<number | null> {
    const best = await this.#sql<
      { posting_chunk_id: string; facet_chunk_id: string; score: number }[]
    >`
      SELECT pc.id AS posting_chunk_id, fc.id AS facet_chunk_id,
             1 - (pc.embedding <=> fc.embedding) AS score
      FROM discovery.posting_chunks pc
      CROSS JOIN discovery.facet_chunks fc
      WHERE pc.posting_id = ${pair.postingId} AND pc.model = ${model}
        AND pc.content_hash = ${pair.postingContentHash}
        AND fc.facet_id = ${pair.facetId} AND fc.model = ${model}
        AND fc.content_hash = ${pair.facetContentHash}
      ORDER BY pc.embedding <=> fc.embedding
      LIMIT 1
    `;
    const row = best[0];
    if (row === undefined) return null;

    await this.#sql`
      INSERT INTO discovery.matches
        (posting_id, facet_id, score, posting_chunk_id, facet_chunk_id, model,
         posting_content_hash, facet_content_hash, scored_at)
      VALUES
        (${pair.postingId}, ${pair.facetId}, ${row.score}, ${row.posting_chunk_id},
         ${row.facet_chunk_id}, ${model}, ${pair.postingContentHash},
         ${pair.facetContentHash}, ${at})
      ON CONFLICT (posting_id, facet_id) DO UPDATE SET
        score                = EXCLUDED.score,
        posting_chunk_id     = EXCLUDED.posting_chunk_id,
        facet_chunk_id       = EXCLUDED.facet_chunk_id,
        model                = EXCLUDED.model,
        posting_content_hash = EXCLUDED.posting_content_hash,
        facet_content_hash   = EXCLUDED.facet_content_hash,
        scored_at            = EXCLUDED.scored_at
    `;
    return Number(row.score);
  }

  /**
   * Per-chunk best similarity across all active, fresh facet chunks. The low
   * end of these is the gap view: passages of the posting with no counterpart
   * anywhere in the profile (§7).
   */
  async refreshBestScores(
    postingIds: readonly PostingId[],
    model: string,
    at: Date,
  ): Promise<void> {
    if (postingIds.length === 0) return;
    await this.#sql`
      UPDATE discovery.posting_chunks pc
      SET best_score = sub.best, scored_at = ${at}
      FROM (
        SELECT pc2.id, max(1 - (pc2.embedding <=> fc.embedding)) AS best
        FROM discovery.posting_chunks pc2
        JOIN discovery.facet_chunks fc
          ON fc.model = pc2.model
        JOIN discovery.profile_facets f
          ON f.id = fc.facet_id AND f.active AND f.content_hash = fc.content_hash
        WHERE pc2.posting_id = ANY(${[...postingIds] as string[]}) AND pc2.model = ${model}
        GROUP BY pc2.id
      ) sub
      WHERE pc.id = sub.id
    `;
  }

  async listCandidates(
    opts: { facetId?: FacetId; limit?: number } = {},
  ): Promise<MatchCandidate[]> {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const rows = await this.#sql<CandidateRow[]>`
      SELECT ${this.#sql.unsafe(CANDIDATE_SELECT)}
      FROM ${this.#sql.unsafe(CANDIDATE_FROM)}
      WHERE p.currently_listed AND f.active
        AND (${opts.facetId ?? null}::uuid IS NULL OR m.facet_id = ${opts.facetId ?? null})
      ORDER BY p.first_seen_at DESC, p.id, f.name
      LIMIT ${limit}
    `;
    return rows.map(toCandidate);
  }

  async forPosting(postingId: PostingId): Promise<MatchCandidate[]> {
    const rows = await this.#sql<CandidateRow[]>`
      SELECT ${this.#sql.unsafe(CANDIDATE_SELECT)}
      FROM ${this.#sql.unsafe(CANDIDATE_FROM)}
      WHERE m.posting_id = ${postingId}
      ORDER BY m.score DESC
    `;
    return rows.map(toCandidate);
  }

  async allScores(): Promise<ScoreRow[]> {
    const rows = await this.#sql<
      {
        posting_id: string;
        title: string;
        company_name: string;
        facet_name: string;
        score: number;
        scored_at: Date;
      }[]
    >`
      SELECT m.posting_id, p.title, b.company_name, f.name AS facet_name, m.score, m.scored_at
      FROM discovery.matches m
      JOIN discovery.postings p ON p.id = m.posting_id
      JOIN discovery.boards b ON b.id = p.board_id
      JOIN discovery.profile_facets f ON f.id = m.facet_id
      ORDER BY m.score DESC
    `;
    return rows.map((r) => ({
      postingId: r.posting_id as PostingId,
      title: r.title,
      companyName: r.company_name,
      facetName: r.facet_name,
      score: Number(r.score),
      scoredAt: r.scored_at,
    }));
  }
}
