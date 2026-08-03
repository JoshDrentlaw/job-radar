import type { Sql } from "@platform/db.ts";
import type { BoardId, SnapshotId } from "@platform/ids.ts";
import type { Snapshot, SnapshotEntry, SnapshotRepo } from "@domain/discovery/types.ts";

interface SnapshotRow {
  id: string;
  board_id: string;
  run_id: string | null;
  taken_at: Date;
  status: string;
  error_reason: string | null;
  posting_count: number;
  source_url: string;
  adapter_version: string;
}

function toSnapshot(row: SnapshotRow, entries: SnapshotEntry[]): Snapshot {
  return {
    id: row.id as SnapshotId,
    boardId: row.board_id as BoardId,
    runId: row.run_id,
    takenAt: row.taken_at,
    status: row.status as "ok" | "failed",
    errorReason: row.error_reason,
    sourceUrl: row.source_url,
    adapterVersion: row.adapter_version,
    postingCount: Number(row.posting_count),
    entries,
  };
}

export class PostgresSnapshotRepo implements SnapshotRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`
        INSERT INTO discovery.snapshots
          (id, board_id, run_id, taken_at, status, error_reason, posting_count,
           source_url, adapter_version)
        VALUES
          (${snapshot.id}, ${snapshot.boardId}, ${snapshot.runId}, ${snapshot.takenAt},
           ${snapshot.status}, ${snapshot.errorReason}, ${snapshot.entries.length},
           ${snapshot.sourceUrl}, ${snapshot.adapterVersion})
      `;

      if (snapshot.entries.length > 0) {
        // One multi-row insert: a 400-posting board would otherwise be 400
        // round trips per collection.
        const rows = snapshot.entries.map((entry) => ({
          snapshot_id: snapshot.id as string,
          external_id: entry.externalId,
          content_hash: entry.contentHash,
        }));
        await tx`
          INSERT INTO discovery.snapshot_entries
          ${tx(rows, "snapshot_id", "external_id", "content_hash")}
        `;
      }
    });
  }

  /**
   * The previous successful snapshot for a board — the left-hand side of the
   * diff. Failed snapshots are skipped: a fetch that errored saw nothing, and
   * diffing against it would report the entire board as disappeared.
   */
  async latestSuccessful(boardId: BoardId): Promise<Snapshot | null> {
    const rows = await this.#sql<SnapshotRow[]>`
      SELECT id, board_id, run_id, taken_at, status, error_reason, posting_count,
             source_url, adapter_version
      FROM discovery.snapshots
      WHERE board_id = ${boardId} AND status = 'ok'
      ORDER BY taken_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    const entries = await this.#sql<{ external_id: string; content_hash: string }[]>`
      SELECT external_id, content_hash
      FROM discovery.snapshot_entries
      WHERE snapshot_id = ${row.id}
    `;

    return toSnapshot(
      row,
      entries.map((e) => ({ externalId: e.external_id, contentHash: e.content_hash })),
    );
  }

  /** Snapshot headers without their entries, for the board history panel. */
  async recentForBoard(boardId: BoardId, limit: number): Promise<Snapshot[]> {
    const rows = await this.#sql<SnapshotRow[]>`
      SELECT id, board_id, run_id, taken_at, status, error_reason, posting_count,
             source_url, adapter_version
      FROM discovery.snapshots
      WHERE board_id = ${boardId}
      ORDER BY taken_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 100)}
    `;
    return rows.map((row) => toSnapshot(row, []));
  }
}
