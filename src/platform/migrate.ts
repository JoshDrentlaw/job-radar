/**
 * Migration runner.
 *
 * Plain numbered SQL, applied in a transaction, tracked in `schema_migrations`
 * with a checksum. Editing an already-applied migration is an error rather than
 * a silent divergence between what the file says and what the database has.
 *
 * Forward-only in production; `down` exists for local development (§15).
 */

import { join } from "@std/path";
import type { Logger } from "./logger.ts";
import type { Sql } from "./db.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string | null;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

/** Distinct from the app's data locks; guards concurrent deploys. */
const ADVISORY_LOCK_KEY = 4_216_113_007;

const FILE_PATTERN = /^(\d{4,})_([A-Za-z0-9_-]+)\.up\.sql$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries: Migration[] = [];
  const seen = new Map<number, string>();

  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const match = FILE_PATTERN.exec(entry.name);
    if (!match) continue;

    const version = Number(match[1]);
    const name = match[2]!;
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new MigrationError(`Duplicate migration version ${version}: ${previous} and ${name}`);
    }
    seen.set(version, name);

    const upPath = join(dir, entry.name);
    const sql = await Deno.readTextFile(upPath);
    const downPath = join(dir, `${match[1]}_${name}.down.sql`);
    const hasDown = await Deno.stat(downPath).then(() => true).catch(() => false);

    entries.push({
      version,
      name,
      upPath,
      downPath: hasDown ? downPath : null,
      sql,
      checksum: await sha256Hex(sql),
    });
  }

  return entries.sort((a, b) => a.version - b.version);
}

async function ensureRegistry(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    bigint      PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function appliedMigrations(sql: Sql): Promise<AppliedMigration[]> {
  await ensureRegistry(sql);
  const rows = await sql<
    { version: string; name: string; checksum: string; applied_at: Date }[]
  >`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`;
  return rows.map((r) => ({
    version: Number(r.version),
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

/**
 * Refuse to run if the content of an applied migration has changed. This is the
 * loud failure the brief asks for: it means someone edited history, and
 * continuing would apply a schema nobody has a record of.
 */
function verifyChecksums(available: Migration[], applied: AppliedMigration[]): void {
  const byVersion = new Map(available.map((m) => [m.version, m]));
  for (const record of applied) {
    const migration = byVersion.get(record.version);
    if (!migration) {
      throw new MigrationError(
        `Migration ${record.version}_${record.name} is recorded as applied but its file is missing.`,
      );
    }
    if (migration.checksum !== record.checksum) {
      throw new MigrationError(
        `Checksum mismatch for migration ${record.version}_${record.name}.\n` +
          `  recorded: ${record.checksum}\n  on disk:  ${migration.checksum}\n` +
          "An applied migration was edited. Never edit an applied migration — add a new one.",
      );
    }
  }
}

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly alreadyCurrent: boolean;
}

export async function migrateUp(
  sql: Sql,
  dir: string,
  logger: Logger,
): Promise<MigrateResult> {
  const available = await loadMigrations(dir);
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    const applied = await appliedMigrations(sql);
    verifyChecksums(available, applied);

    const appliedVersions = new Set(applied.map((a) => a.version));
    const pending = available.filter((m) => !appliedVersions.has(m.version));

    if (pending.length === 0) {
      logger.info("migrations up to date", { count: applied.length });
      return { applied: [], alreadyCurrent: true };
    }

    const done: number[] = [];
    for (const migration of pending) {
      logger.info("applying migration", { version: migration.version, name: migration.name });
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
        `;
      });
      done.push(migration.version);
    }
    logger.info("migrations applied", { versions: done });
    return { applied: done, alreadyCurrent: false };
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

/** Local-development convenience. Not for production use (§15). */
export async function migrateDown(
  sql: Sql,
  dir: string,
  steps: number,
  logger: Logger,
): Promise<number[]> {
  const available = await loadMigrations(dir);
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    const applied = await appliedMigrations(sql);
    verifyChecksums(available, applied);

    const byVersion = new Map(available.map((m) => [m.version, m]));
    const target = [...applied].reverse().slice(0, steps);
    const reverted: number[] = [];

    for (const record of target) {
      const migration = byVersion.get(record.version)!;
      if (!migration.downPath) {
        throw new MigrationError(
          `Migration ${record.version}_${record.name} has no down file; cannot revert.`,
        );
      }
      const downSql = await Deno.readTextFile(migration.downPath);
      logger.warn("reverting migration", { version: record.version, name: record.name });
      await sql.begin(async (tx) => {
        await tx.unsafe(downSql);
        await tx`DELETE FROM schema_migrations WHERE version = ${record.version}`;
      });
      reverted.push(record.version);
    }
    return reverted;
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}
