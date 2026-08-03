import type { Sql } from "@platform/db.ts";
import type { LoginAttempt, LoginAttemptRepo } from "@auth/types.ts";

export class PostgresLoginAttemptRepo implements LoginAttemptRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async record(attempt: LoginAttempt): Promise<void> {
    await this.#sql`
      INSERT INTO app.login_attempts (ip, username, succeeded, at)
      VALUES (${attempt.ip}::inet, ${attempt.username}, ${attempt.succeeded}, ${attempt.at})
    `;
  }

  async recentFailures(ip: string, since: Date): Promise<Date[]> {
    const rows = await this.#sql<{ at: Date }[]>`
      SELECT at
      FROM app.login_attempts
      WHERE ip = ${ip}::inet AND succeeded = false AND at >= ${since}
      ORDER BY at DESC
    `;
    return rows.map((r) => r.at);
  }

  async clearForIp(ip: string): Promise<void> {
    await this.#sql`
      DELETE FROM app.login_attempts WHERE ip = ${ip}::inet AND succeeded = false
    `;
  }
}
