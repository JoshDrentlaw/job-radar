import type { Sql } from "@platform/db.ts";
import type {
  ClaimedProspect,
  NewProspect,
  Prospect,
  ProspectCounts,
  ProspectOutcome,
  ProspectQuery,
  ProspectRepo,
} from "@domain/discovery/prospect.ts";

interface ProspectRow {
  query: string;
  source: string | null;
  enqueued_at: Date;
  resolved_at: Date | null;
  attempts: number;
  hits: number | null;
  last_error: string | null;
}

function toProspect(row: ProspectRow): Prospect {
  return {
    query: row.query,
    enqueuedAt: row.enqueued_at,
    attempts: Number(row.attempts),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.hits !== null ? { hits: Number(row.hits) } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

export class PostgresProspectRepo implements ProspectRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * One statement for the whole paste. `ON CONFLICT DO NOTHING` carries no
   * target deliberately: the table has two unique constraints — the primary key
   * and the case-folded index — and a name colliding on either one is the same
   * question already queued.
   */
  async enqueue(entries: readonly NewProspect[]): Promise<number> {
    if (entries.length === 0) return 0;
    const queries = entries.map((entry) => entry.query);
    const sources = entries.map((entry) => entry.source ?? null);

    const rows = await this.#sql<{ query: string }[]>`
      INSERT INTO discovery.prospects (query, source)
      SELECT * FROM unnest(${queries}::text[], ${sources}::text[])
      ON CONFLICT DO NOTHING
      RETURNING query
    `;
    return rows.length;
  }

  /**
   * Lease a slice. `SKIP LOCKED` rather than waiting, so two runs overlapping
   * take different rows instead of the second one blocking behind the first.
   *
   * The subquery is what carries `FOR UPDATE SKIP LOCKED`; the outer UPDATE
   * stamps the lease and bumps the attempt counter. Attempts increment on claim
   * rather than on failure, so a run that dies without settling still spends an
   * attempt — otherwise a prospect that reliably kills the drain would be
   * retried forever.
   */
  async claim(
    limit: number,
    opts: { now: Date; leaseCutoff: Date; maxAttempts: number },
  ): Promise<ClaimedProspect[]> {
    if (limit <= 0) return [];
    const rows = await this.#sql<{ query: string; source: string | null; attempts: number }[]>`
      UPDATE discovery.prospects SET
        started_at = ${opts.now},
        attempts   = attempts + 1
      WHERE query IN (
        SELECT query FROM discovery.prospects
        WHERE resolved_at IS NULL
          AND attempts < ${opts.maxAttempts}
          AND (started_at IS NULL OR started_at < ${opts.leaseCutoff})
        ORDER BY enqueued_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING query, source, attempts
    `;
    return rows.map((row) => ({
      query: row.query,
      attempts: Number(row.attempts),
      ...(row.source !== null ? { source: row.source } : {}),
    }));
  }

  /**
   * A deferred prospect releases its lease and keeps its reason, which leaves
   * it pending for the next run. It does *not* clear `attempts` — that counter
   * is what eventually stops a name nobody can resolve from being asked forever.
   */
  async settle(query: string, outcome: ProspectOutcome): Promise<void> {
    if (outcome.kind === "resolved") {
      await this.#sql`
        UPDATE discovery.prospects SET
          resolved_at = ${outcome.at},
          hits        = ${outcome.hits},
          last_error  = ${outcome.note ?? null},
          started_at  = NULL
        WHERE query = ${query}
      `;
      return;
    }
    await this.#sql`
      UPDATE discovery.prospects SET
        started_at = NULL,
        last_error = ${outcome.reason}
      WHERE query = ${query}
    `;
  }

  /**
   * `resolved_at IS NULL` guards against un-spending an attempt on a row that
   * settled between the claim and the release — the release only ever gives
   * back work that was never done.
   */
  async release(queries: readonly string[]): Promise<void> {
    if (queries.length === 0) return;
    await this.#sql`
      UPDATE discovery.prospects SET
        started_at = NULL,
        attempts   = greatest(attempts - 1, 0)
      WHERE query = ANY(${queries as string[]}) AND resolved_at IS NULL
    `;
  }

  /**
   * Stuck rows are counted separately rather than folded into pending: a queue
   * reporting fifty pending when forty of them will never be attempted again is
   * a count that misleads (§10).
   */
  async counts(maxAttempts: number): Promise<ProspectCounts> {
    const [row] = await this.#sql<
      { pending: string; resolved: string; stuck: string }[]
    >`
      SELECT
        count(*) FILTER (
          WHERE resolved_at IS NULL AND attempts < ${maxAttempts}
        ) AS pending,
        count(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
        count(*) FILTER (
          WHERE resolved_at IS NULL AND attempts >= ${maxAttempts}
        ) AS stuck
      FROM discovery.prospects
    `;
    return {
      pending: Number(row?.pending ?? 0),
      resolved: Number(row?.resolved ?? 0),
      stuck: Number(row?.stuck ?? 0),
    };
  }

  async list(query: ProspectQuery): Promise<Prospect[]> {
    const rows = query.pendingOnly === true
      ? await this.#sql<ProspectRow[]>`
        SELECT query, source, enqueued_at, resolved_at, attempts, hits, last_error
        FROM discovery.prospects
        WHERE resolved_at IS NULL
        ORDER BY enqueued_at
        LIMIT ${query.limit}
      `
      : await this.#sql<ProspectRow[]>`
        SELECT query, source, enqueued_at, resolved_at, attempts, hits, last_error
        FROM discovery.prospects
        ORDER BY resolved_at IS NOT NULL, enqueued_at
        LIMIT ${query.limit}
      `;
    return rows.map(toProspect);
  }

  async clearResolved(): Promise<number> {
    const rows = await this.#sql<{ query: string }[]>`
      DELETE FROM discovery.prospects WHERE resolved_at IS NOT NULL RETURNING query
    `;
    return rows.length;
  }
}
