import type { Sql } from "@platform/db.ts";
import { type BoardId, boardId, type Platform } from "@platform/ids.ts";
import type { Board, BoardInput, BoardRegistry, FetchStatus } from "@domain/discovery/types.ts";

interface BoardRow {
  id: string;
  platform: string;
  slug: string;
  company_name: string;
  active: boolean;
  notes: string | null;
  tags: string[];
  added_at: Date;
  last_fetch_status: string;
  last_fetch_at: Date | null;
  last_fetch_error: string | null;
  consecutive_failures: number;
}

function toBoard(row: BoardRow): Board {
  return {
    id: row.id as BoardId,
    platform: row.platform as Platform,
    slug: row.slug,
    companyName: row.company_name,
    active: row.active,
    tags: row.tags,
    addedAt: row.added_at,
    lastFetchStatus: row.last_fetch_status as FetchStatus,
    consecutiveFailures: Number(row.consecutive_failures),
    ...(row.notes !== null ? { notes: row.notes } : {}),
    ...(row.last_fetch_at !== null ? { lastFetchAt: row.last_fetch_at } : {}),
    ...(row.last_fetch_error !== null ? { lastFetchError: row.last_fetch_error } : {}),
  };
}

const COLUMNS = `id, platform, slug, company_name, active, notes, tags, added_at,
                 last_fetch_status, last_fetch_at, last_fetch_error, consecutive_failures`;

export class PostgresBoardRepo implements BoardRegistry {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(opts: { activeOnly?: boolean } = {}): Promise<Board[]> {
    const rows = opts.activeOnly === true
      ? await this.#sql<BoardRow[]>`
          SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.boards
          WHERE active ORDER BY company_name, slug`
      : await this.#sql<BoardRow[]>`
          SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.boards
          ORDER BY company_name, slug`;
    return rows.map(toBoard);
  }

  async get(id: BoardId): Promise<Board | null> {
    const rows = await this.#sql<BoardRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.boards WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toBoard(row) : null;
  }

  /**
   * Upsert by identity, not by row. A board's identity is its platform and slug;
   * everything else (company name, notes, tags, active) is user-authored and is
   * overwritten by the edit. Fetch history is deliberately left alone.
   */
  async upsert(board: BoardInput): Promise<Board> {
    const id = boardId(board.platform, board.slug);
    const rows = await this.#sql<BoardRow[]>`
      INSERT INTO discovery.boards (id, platform, slug, company_name, active, notes, tags)
      VALUES (
        ${id}, ${board.platform}, ${board.slug}, ${board.companyName},
        ${board.active ?? true}, ${board.notes ?? null}, ${(board.tags ?? []) as string[]}
      )
      ON CONFLICT (id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        active       = EXCLUDED.active,
        notes        = EXCLUDED.notes,
        tags         = EXCLUDED.tags
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    return toBoard(rows[0]!);
  }

  async deactivate(id: BoardId): Promise<void> {
    await this.#sql`UPDATE discovery.boards SET active = false WHERE id = ${id}`;
  }

  /** Removes the board and, by cascade, its postings and snapshots. */
  async remove(id: BoardId): Promise<void> {
    await this.#sql`DELETE FROM discovery.boards WHERE id = ${id}`;
  }

  /**
   * Success resets the failure counter; failure increments it. Crossing a
   * threshold is what n8n alerts on, and almost always means a slug changed or
   * the company moved ATS (§12).
   */
  async recordFetchOutcome(
    id: BoardId,
    outcome: { status: "ok" | "failed"; at: Date; error?: string },
  ): Promise<void> {
    if (outcome.status === "ok") {
      await this.#sql`
        UPDATE discovery.boards
        SET last_fetch_status = 'ok',
            last_fetch_at = ${outcome.at},
            last_fetch_error = NULL,
            consecutive_failures = 0
        WHERE id = ${id}
      `;
    } else {
      await this.#sql`
        UPDATE discovery.boards
        SET last_fetch_status = 'failed',
            last_fetch_at = ${outcome.at},
            last_fetch_error = ${outcome.error ?? null},
            consecutive_failures = consecutive_failures + 1
        WHERE id = ${id}
      `;
    }
  }
}
