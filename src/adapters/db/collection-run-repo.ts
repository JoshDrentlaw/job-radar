import type { Sql } from "@platform/db.ts";
import type {
  BoardOutcome,
  CollectionReport,
  CollectionRun,
  CollectionRunRepo,
} from "@domain/discovery/coverage.ts";
import type { BoardId } from "@platform/ids.ts";

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

interface BoardOutcomeRow {
  board_id: string;
  company_name: string;
  status: string;
  reason: string | null;
  postings_seen: number;
  appeared: number;
  changed: number;
  disappeared: number;
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

  /**
   * Totals and breakdown in one transaction: a run whose totals were saved but
   * whose per-board rows were lost would report a denominator it cannot explain.
   */
  async finish(report: CollectionReport): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`
        UPDATE discovery.collection_runs SET
          finished_at          = ${report.finishedAt},
          boards_configured    = ${report.boardsConfigured},
          boards_fetched       = ${report.boardsFetched},
          boards_failed        = ${report.boardsFailed},
          postings_seen        = ${report.postingsSeen},
          postings_new         = ${report.postingsNew},
          postings_changed     = ${report.postingsChanged},
          postings_disappeared = ${report.postingsDisappeared}
        WHERE id = ${report.id}
      `;

      if (report.boards.length === 0) return;
      const rows = report.boards.map((board) => ({
        run_id: report.id,
        board_id: board.boardId,
        company_name: board.companyName,
        status: board.status,
        reason: board.reason ?? null,
        postings_seen: board.postingsSeen,
        appeared: board.appeared,
        changed: board.changed,
        disappeared: board.disappeared,
      }));
      // A retried finish for the same run overwrites rather than conflicting.
      await tx`
        INSERT INTO discovery.run_boards ${tx(rows)}
        ON CONFLICT (run_id, board_id) DO UPDATE SET
          company_name  = EXCLUDED.company_name,
          status        = EXCLUDED.status,
          reason        = EXCLUDED.reason,
          postings_seen = EXCLUDED.postings_seen,
          appeared      = EXCLUDED.appeared,
          changed       = EXCLUDED.changed,
          disappeared   = EXCLUDED.disappeared
      `;
    });
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

  /**
   * Failures first: the boards that contributed nothing are the point of the
   * view, and burying them under twenty successes would defeat it.
   */
  async boardOutcomes(runId: string): Promise<BoardOutcome[]> {
    const rows = await this.#sql<BoardOutcomeRow[]>`
      SELECT board_id, company_name, status, reason, postings_seen, appeared, changed,
             disappeared
      FROM discovery.run_boards
      WHERE run_id = ${runId}
      ORDER BY (status = 'failed') DESC, company_name ASC
    `;
    return rows.map((row) => ({
      boardId: row.board_id as BoardId,
      companyName: row.company_name,
      status: row.status as "ok" | "failed",
      ...(row.reason === null ? {} : { reason: row.reason }),
      postingsSeen: Number(row.postings_seen),
      appeared: Number(row.appeared),
      changed: Number(row.changed),
      disappeared: Number(row.disappeared),
    }));
  }
}
