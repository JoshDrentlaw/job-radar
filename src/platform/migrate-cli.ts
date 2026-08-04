/**
 * `deno task migrate [up|down|status] [steps]`
 */

import { loadToolConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { closeDb, createDb } from "./db.ts";
import { appliedMigrations, loadMigrations, migrateDown, migrateUp } from "./migrate.ts";

const MIGRATIONS_DIR = "./migrations";

async function main(): Promise<number> {
  const config = loadToolConfig();
  const logger = createLogger(config.logLevel, { component: "migrate" });
  const sql = createDb(config.databaseUrl, { max: 1 });

  const command = Deno.args[0] ?? "up";
  try {
    switch (command) {
      case "up": {
        await migrateUp(sql, MIGRATIONS_DIR, logger);
        return 0;
      }
      case "down": {
        if (config.env === "production") {
          logger.error("refusing to run down migrations in production");
          return 1;
        }
        const steps = Number(Deno.args[1] ?? "1");
        if (!Number.isInteger(steps) || steps < 1) {
          logger.error("steps must be a positive integer", { steps: Deno.args[1] });
          return 1;
        }
        await migrateDown(sql, MIGRATIONS_DIR, steps, logger);
        return 0;
      }
      case "status": {
        const available = await loadMigrations(MIGRATIONS_DIR);
        const applied = await appliedMigrations(sql);
        const appliedVersions = new Set(applied.map((a) => a.version));
        for (const migration of available) {
          const mark = appliedVersions.has(migration.version) ? "applied" : "pending";
          console.log(`${String(migration.version).padStart(4, "0")}  ${mark}  ${migration.name}`);
        }
        return 0;
      }
      default: {
        console.error(`Unknown command: ${command}. Expected up, down or status.`);
        return 1;
      }
    }
  } catch (error) {
    logger.error("migration failed", { error });
    return 1;
  } finally {
    await closeDb(sql);
  }
}

Deno.exit(await main());
