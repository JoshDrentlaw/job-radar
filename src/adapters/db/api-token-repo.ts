import type { Sql } from "@platform/db.ts";
import type { ApiToken, ApiTokenRepo } from "@auth/api-token.ts";

interface TokenRow {
  id: string;
  label: string;
  token_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** token_hash is deliberately absent from every select — nothing needs to read it. */
const COLUMNS = "id, label, token_prefix, created_at, last_used_at, revoked_at";

export class PostgresApiTokenRepo implements ApiTokenRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(): Promise<ApiToken[]> {
    const rows = await this.#sql<TokenRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM app.api_tokens
      ORDER BY revoked_at NULLS FIRST, created_at DESC
    `;
    return rows.map(toToken);
  }

  async create(input: {
    label: string;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<ApiToken> {
    const rows = await this.#sql<TokenRow[]>`
      INSERT INTO app.api_tokens (label, token_hash, token_prefix)
      VALUES (${input.label}, ${input.tokenHash}, ${input.tokenPrefix})
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    return toToken(rows[0]!);
  }

  /**
   * Lookup by hash — a wrong token matches no row rather than being compared
   * against a stored secret, because no secret is stored. `last_used_at` is
   * stamped in the same statement so a compromised token's use is visible.
   */
  async findActiveByHash(hash: string, usedAt: Date): Promise<ApiToken | null> {
    const rows = await this.#sql<TokenRow[]>`
      UPDATE app.api_tokens
      SET last_used_at = ${usedAt}
      WHERE token_hash = ${hash} AND revoked_at IS NULL
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    const row = rows[0];
    return row ? toToken(row) : null;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.#sql`
      UPDATE app.api_tokens SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL
    `;
  }
}
