/**
 * Authentication types and the ports the auth service depends on.
 *
 * There is one user, forever (§2). No roles, no permissions matrix — if a
 * request has a valid session it is the owner, and if it does not it gets the
 * login page.
 */

import type { SessionId, UserId } from "@platform/ids.ts";

export interface User {
  readonly id: UserId;
  readonly username: string;
  readonly createdAt: Date;
}

export interface StoredUser extends User {
  readonly passwordHash: string;
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionContext {
  readonly userAgent: string | null;
  readonly ip: string;
}

export interface UserRepo {
  findByUsername(username: string): Promise<StoredUser | null>;
  findById(id: UserId): Promise<User | null>;
  create(username: string, passwordHash: string): Promise<User>;
  updatePasswordHash(id: UserId, passwordHash: string): Promise<void>;
  count(): Promise<number>;
}

export interface SessionRepo {
  create(session: Session): Promise<void>;
  find(id: SessionId): Promise<Session | null>;
  touch(id: SessionId, at: Date): Promise<void>;
  revoke(id: SessionId, at: Date): Promise<void>;
  revokeAllForUser(userId: UserId, at: Date): Promise<void>;
  deleteExpired(before: Date): Promise<number>;
}

export interface LoginAttempt {
  readonly ip: string;
  readonly username: string;
  readonly succeeded: boolean;
  readonly at: Date;
}

export interface LoginAttemptRepo {
  record(attempt: LoginAttempt): Promise<void>;
  /** Failures for this IP since `since`, most recent first. */
  recentFailures(ip: string, since: Date): Promise<Date[]>;
  clearForIp(ip: string): Promise<void>;
}
