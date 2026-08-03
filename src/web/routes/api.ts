/**
 * The n8n boundary (§12). "The app owns the work. n8n owns the schedule and the
 * delivery."
 *
 * These routes are mounted before the session middleware and carry their own
 * bearer authentication, so:
 *
 *  - a session cookie grants nothing here, and a bearer token grants nothing
 *    anywhere else (§11: "scoped to only the trigger routes");
 *  - CSRF protection does not apply and is not needed — it exists because
 *    browsers attach cookies automatically, and nothing here reads a cookie.
 *
 * Status codes are the contract n8n branches on: 200 clean, **207 partial**
 * (the run finished but something inside it failed), 500 the run itself
 * failed. A failing board must never abort a run (§12), so a board failure is
 * a 207 with detail — never an exception that loses the boards that worked.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "@web/types.ts";
import { bearerFrom } from "@auth/api-token.ts";
import { collect } from "@domain/discovery/collect.ts";
import { embedPending } from "@domain/discovery/embed.ts";
import { scorePending } from "@domain/discovery/match.ts";
import { loadBucketThresholds } from "@domain/discovery/matching.ts";
import { bucketOf } from "@domain/discovery/matching.ts";
import {
  DEFAULT_GHOST_AFTER_DAYS,
  GHOST_AFTER_DAYS_SETTING,
  ghostCutoff,
} from "@domain/pipeline/types.ts";

/**
 * Bearer authentication. Deliberately says nothing about why it failed — this
 * endpoint faces the public internet and an unauthenticated caller learns only
 * that it is not authenticated.
 */
export function bearerAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = bearerFrom(c.req.header("authorization"));
    const token = await c.get("services").apiTokens.verify(presented);
    if (token === null) {
      c.get("logger").warn("api token rejected", { ip: c.get("clientIp"), path: c.req.path });
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("apiTokenLabel", token.label);
    await next();
  };
}

export const apiRoutes = new Hono<AppEnv>();

/**
 * Fetch every active board, diff against the last snapshot, store.
 * 207 when at least one board failed but others succeeded.
 */
apiRoutes.post("/api/jobs/collect", async (c) => {
  const services = c.get("services");
  const logger = c.get("logger");

  const report = await collect({
    boards: services.boards,
    postings: services.postings,
    snapshots: services.snapshots,
    runs: services.runs,
    sourceFor: services.sourceFor,
    clock: services.clock,
    logger,
  }, { trigger: "scheduled" });

  const body = {
    runId: report.id,
    boardsConfigured: report.boardsConfigured,
    boardsFetched: report.boardsFetched,
    boardsFailed: report.boardsFailed,
    postingsSeen: report.postingsSeen,
    postingsNew: report.postingsNew,
    postingsChanged: report.postingsChanged,
    postingsDisappeared: report.postingsDisappeared,
    // Named so n8n can alert on the board rather than on a count (§12).
    failures: report.boards
      .filter((board) => board.status === "failed")
      .map((board) => ({ boardId: board.boardId, reason: board.reason ?? "unknown" })),
  };

  // Every board failing is not "partial" — nothing succeeded.
  if (report.boardsConfigured > 0 && report.boardsFailed === report.boardsConfigured) {
    return c.json({ ...body, status: "failed" }, 500);
  }
  if (report.boardsFailed > 0) return c.json({ ...body, status: "partial" }, 207);
  return c.json({ ...body, status: "ok" }, 200);
});

/** Drain the embedding queue. 207 while a backlog remains — more work to do. */
apiRoutes.post("/api/jobs/embed", async (c) => {
  const services = c.get("services");
  if (services.embedder === null) {
    return c.json({ status: "disabled", reason: "no embedding api key configured" }, 500);
  }
  const report = await embedPending({
    facets: services.facets,
    chunks: services.chunks,
    embedder: services.embedder,
    clock: services.clock,
    logger: c.get("logger"),
  });
  const body = { ...report, model: services.embedder.model };
  // A remaining backlog is a successful partial run: n8n can call again rather
  // than waiting a full cycle.
  return c.json(
    { ...body, status: report.postingsRemaining > 0 ? "partial" : "ok" },
    report.postingsRemaining > 0 ? 207 : 200,
  );
});

/** Score new and changed postings against the profile facets. */
apiRoutes.post("/api/jobs/match", async (c) => {
  const services = c.get("services");
  if (services.embedder === null) {
    return c.json({ status: "disabled", reason: "no embedding api key configured" }, 500);
  }
  const report = await scorePending({
    matches: services.matches,
    model: services.embedder.model,
    clock: services.clock,
    logger: c.get("logger"),
  });
  // Pairs waiting on vectors are not a failure — they are the embed job's
  // remaining work — but n8n should know the cycle is not settled.
  return c.json(
    { ...report, status: report.pairsUnready > 0 ? "partial" : "ok" },
    report.pairsUnready > 0 ? 207 : 200,
  );
});

/**
 * New matches since a timestamp, as JSON — the payload n8n formats and sends.
 * Read-only by design: a GET that mutated would make retries unsafe.
 */
apiRoutes.get("/api/jobs/digest", async (c) => {
  const services = c.get("services");
  const rawSince = c.req.query("since") ?? "";
  const since = rawSince === "" ? null : new Date(rawSince);
  if (since !== null && Number.isNaN(since.getTime())) {
    return c.json({ error: "invalid `since`; expected an ISO 8601 timestamp" }, 400);
  }

  const [candidates, thresholds] = await Promise.all([
    services.matches.listCandidates({}),
    loadBucketThresholds(services.settings),
  ]);

  const fresh = since === null
    ? candidates
    : candidates.filter((candidate) => candidate.scoredAt > since);

  const matches = fresh.map((candidate) => ({
    postingId: candidate.postingId,
    title: candidate.title,
    company: candidate.companyName,
    location: candidate.locationRaw,
    facet: candidate.facetName,
    // Buckets, never the raw float: a decimal in a notification invites
    // reading cosine distance as a verdict on candidacy (§7).
    bucket: bucketOf(candidate.score, thresholds),
    matchedPassage: candidate.matchedChunk,
    firstSeenAt: candidate.firstSeenAt.toISOString(),
    asOf: candidate.fetchedAt.toISOString(),
    url: `${c.get("config").baseUrl}/matches/${encodeURIComponent(candidate.postingId)}`,
  }));

  // Boards that could not be read are part of the answer: a count with no
  // denominator is a misleading artifact (§10).
  const boards = await services.boards.list({ activeOnly: true });
  const unreadable = boards.filter((board) => board.lastFetchStatus !== "ok");

  return c.json({
    status: "ok",
    since: since?.toISOString() ?? null,
    generatedAt: services.clock.now().toISOString(),
    counts: {
      strong: matches.filter((m) => m.bucket === "strong").length,
      plausible: matches.filter((m) => m.bucket === "plausible").length,
      weak: matches.filter((m) => m.bucket === "weak").length,
    },
    coverage: {
      activeBoards: boards.length,
      unreadableBoards: unreadable.map((board) => ({
        boardId: board.id,
        company: board.companyName,
        consecutiveFailures: board.consecutiveFailures,
        reason: board.lastFetchError ?? "unknown",
      })),
    },
    matches,
  }, 200);
});

/**
 * Pipeline hygiene: mark applications ghosted once silence passes the window.
 *
 * A fifth endpoint beyond the brief's four, because the alternative was worse:
 * folding it into `/match` would put a pipeline concern inside the discovery
 * context, and the two are meant to stay genuinely separate (§4). Folding it
 * into `/digest` would make a GET mutate.
 */
apiRoutes.post("/api/jobs/sweep", async (c) => {
  const services = c.get("services");
  const now = services.clock.now();
  const afterDays = await services.settings.get<number>(GHOST_AFTER_DAYS_SETTING) ??
    DEFAULT_GHOST_AFTER_DAYS;

  const stale = await services.applications.findStale(ghostCutoff(now, afterDays));
  for (const application of stale) {
    await services.applications.changeStatus(application.id, "ghosted", {
      detail: `No activity for ${afterDays} days. This says nothing about the employer's ` +
        `intentions — only that nothing has happened.`,
      source: "rule",
      at: now,
    });
  }
  if (stale.length > 0) {
    c.get("logger").info("applications ghosted by rule", { count: stale.length, afterDays });
  }

  return c.json({
    status: "ok",
    afterDays,
    ghosted: stale.map((a) => ({ id: a.id, title: a.postingTitle, company: a.companyName })),
  }, 200);
});
