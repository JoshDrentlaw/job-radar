import type { Sql } from "@platform/db.ts";
import type { BoardId, Platform, PostingId } from "@platform/ids.ts";
import type {
  Compensation,
  Posting,
  PostingQuery,
  PostingRepo,
  RemoteHint,
} from "@domain/discovery/types.ts";

interface PostingRow {
  id: string;
  board_id: string;
  external_id: string;
  title: string;
  location_raw: string;
  workplace_raw: string | null;
  employment_type: string | null;
  department: string | null;
  description_text: string;
  compensation: Compensation | null;
  apply_url: string;
  posted_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  currently_listed: boolean;
  provenance_platform: string;
  provenance_adapter_version: string;
  provenance_source_url: string;
  provenance_fetched_at: Date;
  provenance_content_hash: string;
  location_normalized: string | null;
  remote_hint: string | null;
  derivation_version: string | null;
  derived_at: Date | null;
  company_name?: string;
}

function toPosting(row: PostingRow): Posting {
  return {
    id: row.id as PostingId,
    boardId: row.board_id as BoardId,
    externalId: row.external_id,
    title: row.title,
    locationRaw: row.location_raw,
    descriptionText: row.description_text,
    applyUrl: row.apply_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    currentlyListed: row.currently_listed,
    ...(row.workplace_raw !== null ? { workplaceRaw: row.workplace_raw } : {}),
    ...(row.employment_type !== null ? { employmentType: row.employment_type } : {}),
    ...(row.department !== null ? { department: row.department } : {}),
    ...(row.compensation !== null ? { compensation: row.compensation } : {}),
    ...(row.posted_at !== null ? { postedAt: row.posted_at } : {}),
    provenance: {
      platform: row.provenance_platform as Platform,
      adapterVersion: row.provenance_adapter_version,
      sourceUrl: row.provenance_source_url,
      fetchedAt: row.provenance_fetched_at,
      contentHash: row.provenance_content_hash,
    },
    derived: row.derivation_version === null ? null : {
      locationNormalized: row.location_normalized,
      remoteHint: (row.remote_hint ?? "unknown") as RemoteHint,
      derivationVersion: row.derivation_version,
      derivedAt: row.derived_at!,
    },
  };
}

/**
 * Asserted columns come from `postings`; derived ones are joined from
 * `posting_derived` and are null when nothing has been derived yet. The
 * separation is the schema's, not this query's (§5).
 */
const SELECT_POSTING = `
  p.id, p.board_id, p.external_id, p.title, p.location_raw, p.workplace_raw, p.employment_type,
  p.department, p.description_text, p.compensation, p.apply_url, p.posted_at,
  p.first_seen_at, p.last_seen_at, p.currently_listed,
  p.provenance_platform, p.provenance_adapter_version, p.provenance_source_url,
  p.provenance_fetched_at, p.provenance_content_hash,
  d.location_normalized, d.remote_hint, d.derivation_version, d.derived_at
`;

export class PostgresPostingRepo implements PostingRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async get(id: PostingId): Promise<Posting | null> {
    const rows = await this.#sql<PostingRow[]>`
      SELECT ${this.#sql.unsafe(SELECT_POSTING)}
      FROM discovery.postings p
      LEFT JOIN discovery.posting_derived d ON d.posting_id = p.id
      WHERE p.id = ${id}
    `;
    const row = rows[0];
    return row ? toPosting(row) : null;
  }

  async list(query: PostingQuery): Promise<{ postings: Posting[]; total: number }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const sql = this.#sql;

    // Full-text search over title and description. Postgres' english
    // configuration is a lexical match, not a semantic one — semantic matching
    // is M3's job and lives elsewhere entirely.
    const search = query.search?.trim() ?? "";

    const where = sql`
      WHERE (${query.boardId ?? null}::text IS NULL OR p.board_id = ${query.boardId ?? null})
        AND (${query.includeUnlisted === true} OR p.currently_listed)
        AND (
          ${search === ""} OR
          to_tsvector('english', p.title || ' ' || p.description_text)
            @@ plainto_tsquery('english', ${search})
        )
    `;

    const rows = await sql<PostingRow[]>`
      SELECT ${sql.unsafe(SELECT_POSTING)}
      FROM discovery.postings p
      LEFT JOIN discovery.posting_derived d ON d.posting_id = p.id
      ${where}
      ORDER BY p.first_seen_at DESC, p.id
      LIMIT ${limit} OFFSET ${offset}
    `;

    const counted = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM discovery.postings p ${where}
    `;

    return { postings: rows.map(toPosting), total: Number(counted[0]!.count) };
  }

  /**
   * Insert new postings, update changed ones.
   *
   * `first_seen_at` is preserved on conflict: a posting that disappeared and
   * came back is the same posting, and the date we first saw it is a fact about
   * our observation, not about this fetch.
   */
  async upsertMany(postings: readonly Posting[]): Promise<void> {
    if (postings.length === 0) return;

    await this.#sql.begin(async (tx) => {
      for (const posting of postings) {
        await tx`
          INSERT INTO discovery.postings (
            id, board_id, external_id, title, location_raw, workplace_raw, employment_type,
            department, description_text, compensation, apply_url, posted_at,
            first_seen_at, last_seen_at, currently_listed,
            provenance_platform, provenance_adapter_version, provenance_source_url,
            provenance_fetched_at, provenance_content_hash
          ) VALUES (
            ${posting.id}, ${posting.boardId}, ${posting.externalId}, ${posting.title},
            ${posting.locationRaw}, ${posting.workplaceRaw ?? null},
            ${posting.employmentType ?? null},
            ${posting.department ?? null}, ${posting.descriptionText},
            ${posting.compensation ? tx.json(posting.compensation as never) : null},
            ${posting.applyUrl}, ${posting.postedAt ?? null},
            ${posting.firstSeenAt}, ${posting.lastSeenAt}, ${posting.currentlyListed},
            ${posting.provenance.platform}, ${posting.provenance.adapterVersion},
            ${posting.provenance.sourceUrl}, ${posting.provenance.fetchedAt},
            ${posting.provenance.contentHash}
          )
          ON CONFLICT (id) DO UPDATE SET
            title            = EXCLUDED.title,
            location_raw     = EXCLUDED.location_raw,
            workplace_raw    = EXCLUDED.workplace_raw,
            employment_type  = EXCLUDED.employment_type,
            department       = EXCLUDED.department,
            description_text = EXCLUDED.description_text,
            compensation     = EXCLUDED.compensation,
            apply_url        = EXCLUDED.apply_url,
            posted_at        = EXCLUDED.posted_at,
            last_seen_at     = EXCLUDED.last_seen_at,
            currently_listed = EXCLUDED.currently_listed,
            provenance_platform        = EXCLUDED.provenance_platform,
            provenance_adapter_version = EXCLUDED.provenance_adapter_version,
            provenance_source_url      = EXCLUDED.provenance_source_url,
            provenance_fetched_at      = EXCLUDED.provenance_fetched_at,
            provenance_content_hash    = EXCLUDED.provenance_content_hash
        `;

        if (posting.derived !== null) {
          await tx`
            INSERT INTO discovery.posting_derived (
              posting_id, location_normalized, remote_hint, derivation_version, derived_at
            ) VALUES (
              ${posting.id}, ${posting.derived.locationNormalized},
              ${posting.derived.remoteHint}, ${posting.derived.derivationVersion},
              ${posting.derived.derivedAt}
            )
            ON CONFLICT (posting_id) DO UPDATE SET
              location_normalized = EXCLUDED.location_normalized,
              remote_hint         = EXCLUDED.remote_hint,
              derivation_version  = EXCLUDED.derivation_version,
              derived_at          = EXCLUDED.derived_at
          `;
        }
      }
    });
  }

  async markUnlisted(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void> {
    if (externalIds.length === 0) return;
    await this.#sql`
      UPDATE discovery.postings
      SET currently_listed = false
      WHERE board_id = ${boardId}
        AND external_id = ANY(${externalIds as string[]})
        AND currently_listed
    `;
    // last_seen_at deliberately not advanced: the posting was not seen.
    void at;
  }

  async markListed(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void> {
    if (externalIds.length === 0) return;
    await this.#sql`
      UPDATE discovery.postings
      SET currently_listed = true, last_seen_at = ${at}
      WHERE board_id = ${boardId} AND external_id = ANY(${externalIds as string[]})
    `;
  }

  async touchLastSeen(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void> {
    if (externalIds.length === 0) return;
    await this.#sql`
      UPDATE discovery.postings
      SET last_seen_at = ${at}
      WHERE board_id = ${boardId} AND external_id = ANY(${externalIds as string[]})
    `;
  }

  async countByBoard(): Promise<Map<BoardId, { listed: number; total: number }>> {
    const rows = await this.#sql<{ board_id: string; listed: string; total: string }[]>`
      SELECT board_id,
             count(*) FILTER (WHERE currently_listed)::text AS listed,
             count(*)::text AS total
      FROM discovery.postings
      GROUP BY board_id
    `;
    return new Map(
      rows.map((
        r,
      ) => [r.board_id as BoardId, { listed: Number(r.listed), total: Number(r.total) }]),
    );
  }
}
