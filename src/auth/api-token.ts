/**
 * Bearer tokens for the n8n trigger routes (§11, §12).
 *
 * §11 requires two things that look contradictory: secrets come from the
 * environment and never the database, and this token is rotatable from the UI.
 * Both hold because only a SHA-256 of the token is stored — the same shape
 * `app.sessions` uses for the session cookie. The plaintext exists once, in the
 * response that creates it, and is never recoverable afterwards. A database
 * disclosure yields no usable credential.
 *
 * These tokens authenticate n8n and nothing else: they reach the job routes and
 * no other part of the application (§11).
 */

import type { Clock } from "@platform/clock.ts";
import { randomToken, sha256Hex } from "@platform/hash.ts";

/** Distinguishes an n8n credential from any other opaque string at a glance. */
const TOKEN_PREFIX = "jrq_";
const PREFIX_DISPLAY_LENGTH = TOKEN_PREFIX.length + 6;

export interface ApiToken {
  readonly id: string;
  readonly label: string;
  /** Enough to tell two tokens apart in a list. Not a secret. */
  readonly tokenPrefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface IssuedApiToken {
  readonly token: ApiToken;
  /** Shown once. Never stored, never recoverable. */
  readonly plaintext: string;
}

export interface ApiTokenRepo {
  list(): Promise<ApiToken[]>;
  create(input: {
    label: string;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<ApiToken>;
  /** Active token matching this hash, or null. Also stamps last_used_at. */
  findActiveByHash(hash: string, usedAt: Date): Promise<ApiToken | null>;
  revoke(id: string, at: Date): Promise<void>;
}

export function apiTokenHash(plaintext: string): Promise<string> {
  return sha256Hex(plaintext);
}

export class ApiTokenService {
  readonly #repo: ApiTokenRepo;
  readonly #clock: Clock;

  constructor(repo: ApiTokenRepo, clock: Clock) {
    this.#repo = repo;
    this.#clock = clock;
  }

  list(): Promise<ApiToken[]> {
    return this.#repo.list();
  }

  async issue(label: string): Promise<IssuedApiToken> {
    const plaintext = `${TOKEN_PREFIX}${randomToken(32)}`;
    const token = await this.#repo.create({
      label,
      tokenHash: await apiTokenHash(plaintext),
      tokenPrefix: plaintext.slice(0, PREFIX_DISPLAY_LENGTH),
    });
    return { token, plaintext };
  }

  /**
   * Resolve a presented bearer token. Lookup is by hash, so a wrong token never
   * reaches a comparison against a stored secret — there is no stored secret.
   */
  async verify(presented: string): Promise<ApiToken | null> {
    if (presented === "") return null;
    return await this.#repo.findActiveByHash(
      await apiTokenHash(presented),
      this.#clock.now(),
    );
  }

  revoke(id: string): Promise<void> {
    return this.#repo.revoke(id, this.#clock.now());
  }
}

/** Extract a bearer credential from an Authorization header. */
export function bearerFrom(header: string | undefined): string {
  if (header === undefined) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}
