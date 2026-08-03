/**
 * Session lifecycle (§11).
 *
 * The cookie carries a random token. The database stores only its SHA-256, so a
 * database disclosure does not hand anyone a working session. Sessions have both
 * an idle timeout and an absolute cap, and are individually revocable.
 */

import type { Clock } from "@platform/clock.ts";
import { randomToken, sha256Hex } from "@platform/hash.ts";
import type { SessionId, UserId } from "@platform/ids.ts";
import type { Session, SessionContext, SessionRepo, User, UserRepo } from "./types.ts";

export const SESSION_COOKIE = "job_radar_session";

/** Total lifetime, regardless of activity. */
export const ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Inactivity that ends a session early. */
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/**
 * `last_seen_at` is only written when it is this stale, so ordinary browsing
 * does not turn every page view into a write.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function sessionIdFromToken(token: string): Promise<SessionId> {
  return (await sha256Hex(token)) as SessionId;
}

export interface IssuedSession {
  /** Goes in the cookie. Never stored. */
  readonly token: string;
  readonly session: Session;
}

export class SessionService {
  readonly #sessions: SessionRepo;
  readonly #users: UserRepo;
  readonly #clock: Clock;

  constructor(sessions: SessionRepo, users: UserRepo, clock: Clock) {
    this.#sessions = sessions;
    this.#users = users;
    this.#clock = clock;
  }

  async issue(userId: UserId, context: SessionContext): Promise<IssuedSession> {
    const token = randomToken(32);
    const now = this.#clock.now();
    const session: Session = {
      id: await sessionIdFromToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_LIFETIME_MS),
      revokedAt: null,
      userAgent: context.userAgent,
      ip: context.ip,
    };
    await this.#sessions.create(session);
    return { token, session };
  }

  /**
   * Resolve a cookie token to its user, or null. Expired and revoked sessions
   * resolve to null; an expired session is also revoked on the way out so it
   * stops being a live row.
   */
  async resolve(token: string): Promise<User | null> {
    if (token === "") return null;
    const id = await sessionIdFromToken(token);
    const session = await this.#sessions.find(id);
    if (!session) return null;

    const now = this.#clock.now();
    if (session.revokedAt !== null) return null;

    const idleDeadline = session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS;
    const expired = now.getTime() >= session.absoluteExpiresAt.getTime() ||
      now.getTime() >= idleDeadline;
    if (expired) {
      await this.#sessions.revoke(id, now);
      return null;
    }

    const user = await this.#users.findById(session.userId);
    if (!user) return null;

    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await this.#sessions.touch(id, now);
    }
    return user;
  }

  async revokeByToken(token: string): Promise<void> {
    if (token === "") return;
    await this.#sessions.revoke(await sessionIdFromToken(token), this.#clock.now());
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    await this.#sessions.revokeAllForUser(userId, this.#clock.now());
  }

  /** Housekeeping: drop rows that can no longer authenticate anything. */
  async purgeExpired(): Promise<number> {
    return await this.#sessions.deleteExpired(this.#clock.now());
  }
}
