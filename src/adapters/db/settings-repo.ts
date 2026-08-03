import type { Sql } from "@platform/db.ts";
import type { SettingsRepo } from "@domain/discovery/matching.ts";

/**
 * app.settings: configuration that is genuinely tunable data — bucket
 * thresholds and the like. Secrets stay in the environment and must never be
 * written here (§11).
 */
export class PostgresSettingsRepo implements SettingsRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.#sql<{ value: T }[]>`
      SELECT value FROM app.settings WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#sql`
      INSERT INTO app.settings (key, value)
      VALUES (${key}, ${this.#sql.json(value as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }
}
