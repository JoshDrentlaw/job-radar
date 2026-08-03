import type { Sql } from "@platform/db.ts";
import type { SessionId, UserId } from "@platform/ids.ts";
import type { Session, SessionRepo } from "@auth/types.ts";
import { IDLE_TIMEOUT_MS } from "@auth/session.ts";

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  user_agent: string | null;
  ip: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    userId: row.user_id as UserId,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

export class PostgresSessionRepo implements SessionRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async create(session: Session): Promise<void> {
    await this.#sql`
      INSERT INTO app.sessions
        (id, user_id, created_at, last_seen_at, absolute_expires_at, revoked_at, user_agent, ip)
      VALUES
        (${session.id}, ${session.userId}, ${session.createdAt}, ${session.lastSeenAt},
         ${session.absoluteExpiresAt}, ${session.revokedAt}, ${session.userAgent},
         ${session.ip}::inet)
    `;
  }

  async find(id: SessionId): Promise<Session | null> {
    const rows = await this.#sql<SessionRow[]>`
      SELECT id, user_id, created_at, last_seen_at, absolute_expires_at,
             revoked_at, user_agent, host(ip) AS ip
      FROM app.sessions
      WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async touch(id: SessionId, at: Date): Promise<void> {
    await this.#sql`UPDATE app.sessions SET last_seen_at = ${at} WHERE id = ${id}`;
  }

  async revoke(id: SessionId, at: Date): Promise<void> {
    await this.#sql`
      UPDATE app.sessions SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL
    `;
  }

  async revokeAllForUser(userId: UserId, at: Date): Promise<void> {
    await this.#sql`
      UPDATE app.sessions SET revoked_at = ${at} WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  }

  /**
   * Remove sessions that can no longer authenticate anything: past their
   * absolute cap, idle beyond the timeout, or revoked. Revoked rows are kept
   * briefly so a revocation is still visible in the session list.
   */
  async deleteExpired(before: Date): Promise<number> {
    const idleCutoff = new Date(before.getTime() - IDLE_TIMEOUT_MS);
    const revokedCutoff = new Date(before.getTime() - 24 * 60 * 60 * 1000);
    const result = await this.#sql`
      DELETE FROM app.sessions
      WHERE absolute_expires_at <= ${before}
         OR last_seen_at <= ${idleCutoff}
         OR (revoked_at IS NOT NULL AND revoked_at <= ${revokedCutoff})
    `;
    return result.count;
  }
}
