/**
 * Composition root. The only place in the application where a concrete adapter
 * is named (§4).
 */

import { loadConfig } from "@platform/config.ts";
import { createLogger } from "@platform/logger.ts";
import { closeDb, createDb } from "@platform/db.ts";
import { systemClock } from "@platform/clock.ts";
import type { Platform } from "@platform/ids.ts";
import { migrateUp } from "@platform/migrate.ts";

import { PostgresBoardRepo } from "@adapters/db/board-repo.ts";
import { PostgresPostingRepo } from "@adapters/db/posting-repo.ts";
import { PostgresSnapshotRepo } from "@adapters/db/snapshot-repo.ts";
import { PostgresCollectionRunRepo } from "@adapters/db/collection-run-repo.ts";
import { PostgresUserRepo } from "@adapters/db/user-repo.ts";
import { PostgresSessionRepo } from "@adapters/db/session-repo.ts";
import { PostgresLoginAttemptRepo } from "@adapters/db/login-attempt-repo.ts";
import { buildUserAgent, PoliteFetcher } from "@adapters/ats/http.ts";
import { GreenhouseSource } from "@adapters/ats/greenhouse.ts";

import { SessionService } from "@auth/session.ts";
import { LoginRateLimiter } from "@auth/rate-limit.ts";
import type { BoardSource } from "@domain/discovery/types.ts";
import { createApp } from "@web/app.ts";
import type { Services } from "@web/services.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel, { app: "job-radar" });
const sql = createDb(config.databaseUrl);

// Migrations run at boot. A single-user app on one droplet has no rolling
// deploy to coordinate with, and a schema that silently lags the code is a
// worse failure than a slow start.
await migrateUp(sql, "./migrations", logger);

const http = new PoliteFetcher({ userAgent: buildUserAgent(config.contactUrl) });

/**
 * Platform to adapter. Platforms without an entry are not an error at startup —
 * `collect` records "no adapter registered" against the board and carries on,
 * which is what the coverage ledger should say (§10).
 */
const sources = new Map<Platform, BoardSource>([
  ["greenhouse", new GreenhouseSource(http, () => systemClock.now())],
]);

const users = new PostgresUserRepo(sql);

const services: Services = {
  boards: new PostgresBoardRepo(sql),
  postings: new PostgresPostingRepo(sql),
  snapshots: new PostgresSnapshotRepo(sql),
  runs: new PostgresCollectionRunRepo(sql),
  users,
  sessions: new SessionService(new PostgresSessionRepo(sql), users, systemClock),
  rateLimiter: new LoginRateLimiter(new PostgresLoginAttemptRepo(sql), systemClock),
  sourceFor: (platform) => sources.get(platform) ?? null,
  clock: systemClock,
  logger,
};

if (await users.count() === 0) {
  logger.warn(
    "no admin account exists — run `deno task seed-admin` before this app can be signed into",
  );
}

const app = createApp({ config, services, logger });

const server = Deno.serve({
  hostname: config.host,
  port: config.port,
  onListen: ({ hostname, port }) => {
    logger.info("listening", { hostname, port, env: config.env, baseUrl: config.baseUrl });
  },
}, app.fetch);

const shutdown = async () => {
  logger.info("shutting down");
  await server.shutdown();
  await closeDb(sql);
};

Deno.addSignalListener("SIGINT", () => void shutdown());
Deno.addSignalListener("SIGTERM", () => void shutdown());
