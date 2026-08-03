import type { Sql } from "@platform/db.ts";
import type { CollectionRun, CollectionRunRepo } from "@domain/discovery/coverage.ts";

interface RunRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  trigger: string;
  boards_configured: number;
  boards_fetched: number;
  boards_failed: number;
  postings_seen: number;
  postings_new: number;
  postings_changed: number;
  postings_disappeared: number;
}

function toRun(row: RunRow): CollectionRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger as "manual" | "scheduled",
    boardsConfigured: Number(row.boards_configured),
    boardsFetched: Number(row.boards_fetched),
    boardsFailed: Number(row.boards_failed),
    postingsSeen: Number(row.postings_seen),
    postingsNew: Number(row.postings_new),
    postingsChanged: Number(row.postings_changed),
    postingsDisappeared: Number(row.postings_disappeared),
  };
}

const COLUMNS = `id, started_at, finished_at, trigger, boards_configured, boards_fetched,
                 boards_failed, postings_seen, postings_new, postings_changed,
                 postings_disappeared`;

export class PostgresCollectionRunRepo implements CollectionRunRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * The run row is written before any board is touched, so a run that crashes
   * outright still leaves a record with a null `finished_at` rather than
   * vanishing from the ledger.
   */
  async start(run: Omit<CollectionRun, "finishedAt">): Promise<void> {
    await this.#sql`
      INSERT INTO discovery.collection_runs
        (id, started_at, trigger, boards_configured)
      VALUES (${run.id}, ${run.startedAt}, ${run.trigger}, ${run.boardsConfigured})
    `;
  }

  async finish(run: CollectionRun): Promise<void> {
    await this.#sql`
      UPDATE discovery.collection_runs SET
        finished_at          = ${run.finishedAt},
        boards_configured    = ${run.boardsConfigured},
        boards_fetched       = ${run.boardsFetched},
        boards_failed        = ${run.boardsFailed},
        postings_seen        = ${run.postingsSeen},
        postings_new         = ${run.postingsNew},
        postings_changed     = ${run.postingsChanged},
        postings_disappeared = ${run.postingsDisappeared}
      WHERE id = ${run.id}
    `;
  }

  async recent(limit: number): Promise<CollectionRun[]> {
    const rows = await this.#sql<RunRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.collection_runs
      ORDER BY started_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}
    `;
    return rows.map(toRun);
  }

  async get(id: string): Promise<CollectionRun | null> {
    const rows = await this.#sql<RunRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.collection_runs WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toRun(row) : null;
  }
}
