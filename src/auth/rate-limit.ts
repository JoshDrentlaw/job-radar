/**
 * Login rate limiting with progressive backoff, keyed by IP (§11).
 *
 * The policy is deliberately dumb and stateless-per-call: count recent failures
 * from this IP, map that count to a lockout window, and compare against the most
 * recent failure. Nothing to expire, nothing to keep in memory, and it survives
 * a restart because the record lives in Postgres.
 */

import type { Clock } from "@platform/clock.ts";
import type { LoginAttemptRepo } from "./types.ts";

/**
 * Failures are counted within this window. Older failures stop counting, so an
 * IP that backs off for a while gets its budget back without operator action.
 */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Free attempts before backoff engages at all. */
export const FREE_ATTEMPTS = 3;

/**
 * Backoff after the free attempts are spent: 5s, 15s, 60s, 5m, 15m, then 60m
 * for every failure beyond that. Slow enough to make online guessing pointless,
 * short enough that the legitimate owner fat-fingering a password is not locked
 * out for the evening.
 */
const BACKOFF_LADDER_MS = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export function backoffForFailureCount(failures: number): number {
  const overage = failures - FREE_ATTEMPTS;
  if (overage <= 0) return 0;
  const index = Math.min(overage - 1, BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[index]!;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the next attempt is permitted. Zero when allowed. */
  readonly retryAfterSeconds: number;
  readonly recentFailures: number;
}

export class LoginRateLimiter {
  readonly #attempts: LoginAttemptRepo;
  readonly #clock: Clock;

  constructor(attempts: LoginAttemptRepo, clock: Clock) {
    this.#attempts = attempts;
    this.#clock = clock;
  }

  async check(ip: string): Promise<RateLimitDecision> {
    const now = this.#clock.now();
    const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
    const failures = await this.#attempts.recentFailures(ip, since);

    const backoff = backoffForFailureCount(failures.length);
    if (backoff === 0) {
      return { allowed: true, retryAfterSeconds: 0, recentFailures: failures.length };
    }

    const mostRecent = failures[0]!;
    const unlockAt = mostRecent.getTime() + backoff;
    const remainingMs = unlockAt - now.getTime();
    if (remainingMs <= 0) {
      return { allowed: true, retryAfterSeconds: 0, recentFailures: failures.length };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(remainingMs / 1000),
      recentFailures: failures.length,
    };
  }

  async recordFailure(ip: string, username: string): Promise<void> {
    await this.#attempts.record({ ip, username, succeeded: false, at: this.#clock.now() });
  }

  /** A successful login clears the IP's backoff so the owner is not punished. */
  async recordSuccess(ip: string, username: string): Promise<void> {
    await this.#attempts.record({ ip, username, succeeded: true, at: this.#clock.now() });
    await this.#attempts.clearForIp(ip);
  }
}
