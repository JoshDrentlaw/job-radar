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
import { PostgresBoardCandidateRepo } from "@adapters/db/board-candidate-repo.ts";
import { PostgresProspectRepo } from "@adapters/db/prospect-repo.ts";
import { PostgresPostingRepo } from "@adapters/db/posting-repo.ts";
import { PostgresSnapshotRepo } from "@adapters/db/snapshot-repo.ts";
import { PostgresCollectionRunRepo } from "@adapters/db/collection-run-repo.ts";
import { PostgresUserRepo } from "@adapters/db/user-repo.ts";
import { PostgresSessionRepo } from "@adapters/db/session-repo.ts";
import { PostgresLoginAttemptRepo } from "@adapters/db/login-attempt-repo.ts";
import { PostgresFacetRepo } from "@adapters/db/facet-repo.ts";
import { PostgresChunkRepo } from "@adapters/db/chunk-repo.ts";
import { PostgresMatchRepo } from "@adapters/db/match-repo.ts";
import { PostgresSettingsRepo } from "@adapters/db/settings-repo.ts";
import { PostgresFactRepo } from "@adapters/db/fact-repo.ts";
import { PostgresVariantRepo } from "@adapters/db/variant-repo.ts";
import { PostgresTailoringRepo } from "@adapters/db/tailoring-repo.ts";
import { PostgresDocumentRepo } from "@adapters/db/document-repo.ts";
import { PostgresApplicationRepo } from "@adapters/db/application-repo.ts";
import { PostgresApiTokenRepo } from "@adapters/db/api-token-repo.ts";
import { PostgresChallengeRepo, PostgresCredentialRepo } from "@adapters/db/credential-repo.ts";
import { ApiTokenService } from "@auth/api-token.ts";
import { expectedOriginFrom, PasskeyService } from "@auth/webauthn/service.ts";
import { AnthropicLlmClient } from "@adapters/llm/anthropic.ts";
import { VoyageEmbedder } from "@adapters/embedding/voyage.ts";
import { buildUserAgent, PoliteFetcher } from "@adapters/ats/http.ts";
import { AtsProber } from "@adapters/ats/probe.ts";
import { GreenhouseSource } from "@adapters/ats/greenhouse.ts";
import { LeverSource } from "@adapters/ats/lever.ts";
import { AshbySource } from "@adapters/ats/ashby.ts";

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
// Shares the fetcher, so board lookups queue behind collection on the same host
// rather than doubling the request rate against it.
const prober = new AtsProber(http);

/**
 * Platform to adapter. Platforms without an entry are not an error at startup —
 * `collect` records "no adapter registered" against the board and carries on,
 * which is what the coverage ledger should say (§10).
 */
const sources = new Map<Platform, BoardSource>([
  ["greenhouse", new GreenhouseSource(http, () => systemClock.now())],
  ["lever", new LeverSource(http, () => systemClock.now())],
  ["ashby", new AshbySource(http, () => systemClock.now())],
]);

const users = new PostgresUserRepo(sql);

// Matching is inert without an embedding key; the UI says so instead of the
// process refusing to start — boards and postings work either way.
const embedder = config.voyageApiKey !== undefined
  ? new VoyageEmbedder({ apiKey: config.voyageApiKey, model: config.embeddingModel })
  : null;
if (embedder === null) {
  logger.warn("VOYAGE_API_KEY is not set — embedding and matching are disabled");
}

// Tailoring is likewise optional: the fact set and variants work by hand
// without it, which is exactly how M4 proved the data model.
const llm = config.anthropicApiKey !== undefined
  ? new AnthropicLlmClient({ apiKey: config.anthropicApiKey, model: config.anthropicModel })
  : null;
if (llm === null) {
  logger.warn("ANTHROPIC_API_KEY is not set — tailoring and cover letters are disabled");
}

const services: Services = {
  boards: new PostgresBoardRepo(sql),
  boardCandidates: new PostgresBoardCandidateRepo(sql),
  prospects: new PostgresProspectRepo(sql),
  probeBoard: (platform, slug) => prober.probe(platform, slug),
  postings: new PostgresPostingRepo(sql),
  snapshots: new PostgresSnapshotRepo(sql),
  runs: new PostgresCollectionRunRepo(sql),
  users,
  sessions: new SessionService(new PostgresSessionRepo(sql), users, systemClock),
  rateLimiter: new LoginRateLimiter(new PostgresLoginAttemptRepo(sql), systemClock),
  sourceFor: (platform) => sources.get(platform) ?? null,
  facets: new PostgresFacetRepo(sql),
  chunks: new PostgresChunkRepo(sql),
  matches: new PostgresMatchRepo(sql),
  settings: new PostgresSettingsRepo(sql),
  embedder,
  facts: new PostgresFactRepo(sql),
  variants: new PostgresVariantRepo(sql),
  tailoring: new PostgresTailoringRepo(sql),
  documents: new PostgresDocumentRepo(sql),
  llm,
  applications: new PostgresApplicationRepo(sql),
  apiTokens: new ApiTokenService(new PostgresApiTokenRepo(sql), systemClock),
  passkeys: new PasskeyService(
    new PostgresCredentialRepo(sql),
    new PostgresChallengeRepo(sql),
    systemClock,
    // Scoped to the configured base URL, never to the request's own Host
    // header — which the client controls (§11).
    expectedOriginFrom(config.baseUrl),
  ),
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
