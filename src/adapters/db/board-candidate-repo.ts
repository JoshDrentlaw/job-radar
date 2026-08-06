import type { Sql } from "@platform/db.ts";
import type { Platform } from "@platform/ids.ts";
import type { BoardCandidate, BoardCandidateRepo } from "@domain/discovery/resolve.ts";

interface CandidateRow {
  platform: string;
  slug: string;
  found: boolean;
  company_name: string | null;
  posting_count: number | null;
  sample_titles: string[];
  error: string | null;
  checked_at: Date;
}

function toCandidate(row: CandidateRow): BoardCandidate {
  return {
    platform: row.platform as Platform,
    slug: row.slug,
    found: row.found,
    checkedAt: row.checked_at,
    ...(row.company_name !== null ? { companyName: row.company_name } : {}),
    ...(row.posting_count !== null ? { postingCount: Number(row.posting_count) } : {}),
    ...(row.sample_titles.length > 0 ? { sampleTitles: row.sample_titles } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

const COLUMNS = `platform, slug, found, company_name, posting_count, sample_titles,
                 error, checked_at`;

export class PostgresBoardCandidateRepo implements BoardCandidateRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async lookup(
    pairs: readonly { platform: Platform; slug: string }[],
  ): Promise<BoardCandidate[]> {
    if (pairs.length === 0) return [];
    // One round trip for the whole candidate set rather than one per pair: a
    // two-word company name across three platforms is twelve of them.
    //
    // Two parallel arrays through `unnest` rather than a tuple list, because
    // postgres.js's array helper builds `VALUES`-shaped output and an `IN
    // ((a,b),(c,d))` written that way is a syntax error at the comma.
    const platforms = pairs.map((pair) => pair.platform as string);
    const slugs = pairs.map((pair) => pair.slug);
    const rows = await this.#sql<CandidateRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.board_candidates
      WHERE (platform, slug) IN (
        SELECT * FROM unnest(${platforms}::text[], ${slugs}::text[])
      )
    `;
    return rows.map(toCandidate);
  }

  /**
   * Last answer wins. A candidate row is the current state of one question, not
   * a history of asking it — the checked_at is what makes the answer readable.
   */
  async record(candidate: BoardCandidate, query?: string): Promise<void> {
    await this.#sql`
      INSERT INTO discovery.board_candidates
        (platform, slug, found, company_name, posting_count, sample_titles, error, checked_at, query)
      VALUES (
        ${candidate.platform}, ${candidate.slug}, ${candidate.found},
        ${candidate.companyName ?? null}, ${candidate.postingCount ?? null},
        ${(candidate.sampleTitles ?? []) as string[]},
        ${candidate.error ?? null}, ${candidate.checkedAt}, ${query ?? null}
      )
      ON CONFLICT (platform, slug) DO UPDATE SET
        found         = EXCLUDED.found,
        company_name  = EXCLUDED.company_name,
        posting_count = EXCLUDED.posting_count,
        sample_titles = EXCLUDED.sample_titles,
        error         = EXCLUDED.error,
        checked_at    = EXCLUDED.checked_at,
        query         = COALESCE(EXCLUDED.query, discovery.board_candidates.query)
    `;
  }

  async recent(limit: number): Promise<BoardCandidate[]> {
    const rows = await this.#sql<CandidateRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.board_candidates
      WHERE found ORDER BY checked_at DESC LIMIT ${limit}
    `;
    return rows.map(toCandidate);
  }
}
