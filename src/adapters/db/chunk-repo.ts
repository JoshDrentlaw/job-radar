import type { Sql } from "@platform/db.ts";
import type { FacetId, PostingId } from "@platform/ids.ts";
import type {
  ChunkRepo,
  EmbeddedChunk,
  PostingChunkScore,
  StalePosting,
} from "@domain/discovery/matching.ts";

/**
 * pgvector's text form: '[0.1,0.2,...]'. postgres.js has no vector codec, so
 * vectors travel as strings with an explicit cast on the SQL side.
 */
function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PostgresChunkRepo implements ChunkRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * Listed postings whose current content has no vectors under this model.
   * Oldest first, so a bounded drain works through the backlog in stable order
   * instead of revisiting whatever happens to sort first.
   */
  async stalePostings(model: string, limit: number): Promise<StalePosting[]> {
    const rows = await this.#sql<
      { id: string; title: string; description_text: string; provenance_content_hash: string }[]
    >`
      SELECT p.id, p.title, p.description_text, p.provenance_content_hash
      FROM discovery.postings p
      WHERE p.currently_listed
        AND NOT EXISTS (
          SELECT 1 FROM discovery.posting_chunks c
          WHERE c.posting_id = p.id
            AND c.model = ${model}
            AND c.content_hash = p.provenance_content_hash
        )
      ORDER BY p.first_seen_at, p.id
      LIMIT ${Math.min(Math.max(limit, 1), 1000)}
    `;
    return rows.map((r) => ({
      id: r.id as PostingId,
      title: r.title,
      descriptionText: r.description_text,
      contentHash: r.provenance_content_hash,
    }));
  }

  async stalePostingCount(model: string): Promise<number> {
    const rows = await this.#sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM discovery.postings p
      WHERE p.currently_listed
        AND NOT EXISTS (
          SELECT 1 FROM discovery.posting_chunks c
          WHERE c.posting_id = p.id
            AND c.model = ${model}
            AND c.content_hash = p.provenance_content_hash
        )
    `;
    return Number(rows[0]!.count);
  }

  /**
   * Replacement deletes every chunk for the posting — any model — before
   * inserting. Vector spaces never mix (§7), and superseded vectors do not
   * accumulate. Matches referencing the old chunks go with them by cascade and
   * are rescored from the fresh vectors.
   */
  async replacePostingChunks(
    postingId: PostingId,
    model: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
    at: Date,
  ): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`DELETE FROM discovery.posting_chunks WHERE posting_id = ${postingId}`;
      for (const chunk of chunks) {
        await tx`
          INSERT INTO discovery.posting_chunks
            (posting_id, seq, text, embedding, model, content_hash, embedded_at)
          VALUES
            (${postingId}, ${chunk.seq}, ${chunk.text},
             ${vectorLiteral(chunk.embedding)}::vector, ${model}, ${contentHash}, ${at})
        `;
      }
    });
  }

  async replaceFacetChunks(
    facetId: FacetId,
    model: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
    at: Date,
  ): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`DELETE FROM discovery.facet_chunks WHERE facet_id = ${facetId}`;
      for (const chunk of chunks) {
        await tx`
          INSERT INTO discovery.facet_chunks
            (facet_id, seq, text, embedding, model, content_hash, embedded_at)
          VALUES
            (${facetId}, ${chunk.seq}, ${chunk.text},
             ${vectorLiteral(chunk.embedding)}::vector, ${model}, ${contentHash}, ${at})
        `;
      }
    });
  }

  async postingChunkScores(postingId: PostingId, model: string): Promise<PostingChunkScore[]> {
    const rows = await this.#sql<{ seq: number; text: string; best_score: number | null }[]>`
      SELECT seq, text, best_score
      FROM discovery.posting_chunks
      WHERE posting_id = ${postingId} AND model = ${model}
      ORDER BY seq
    `;
    return rows.map((r) => ({
      seq: Number(r.seq),
      text: r.text,
      bestScore: r.best_score === null ? null : Number(r.best_score),
    }));
  }

  async facetEmbedStatus(
    model: string,
  ): Promise<Map<FacetId, { chunks: number; embeddedAt: Date }>> {
    const rows = await this.#sql<{ facet_id: string; chunks: string; embedded_at: Date }[]>`
      SELECT facet_id, count(*)::text AS chunks, max(embedded_at) AS embedded_at
      FROM discovery.facet_chunks
      WHERE model = ${model}
      GROUP BY facet_id
    `;
    return new Map(
      rows.map((r) => [
        r.facet_id as FacetId,
        { chunks: Number(r.chunks), embeddedAt: r.embedded_at },
      ]),
    );
  }
}
