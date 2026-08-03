/**
 * Postgres connection handling.
 *
 * Repositories receive a `Sql` handle rather than reaching for a global, so a
 * repository call can be run inside a caller's transaction without knowing it.
 */

import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, never>>;
/** The handle inside a transaction. Supports savepoints via its own `begin`. */
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Row = postgres.Row;

export interface DbOptions {
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
}

/**
 * Small pool by default: this is a single-user app sharing a droplet with n8n
 * and Postgres itself (§13). Connections are not the scarce resource; RAM is.
 */
export function createDb(databaseUrl: string, options: DbOptions = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 5,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    // Timestamps are stored and compared in UTC (§15). Display converts.
    types: {},
    onnotice: () => {},
  }) as Sql;
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * postgres.js already provides this; the wrapper exists so call sites depend on
 * our own module rather than on the driver's surface.
 */
export function withTransaction<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}

export async function closeDb(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
