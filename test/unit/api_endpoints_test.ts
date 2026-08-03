/**
 * The n8n boundary as a contract (§12).
 *
 * Two things are under test here and neither is the happy path for its own
 * sake: that the trigger routes are reachable *only* with a bearer token and
 * that the bearer token reaches *only* them, and that the status code n8n
 * branches on tells the truth about partial degradation.
 *
 * The app is the real one from `createApp`, because the ordering of the
 * middleware *is* the security posture — a test that re-declared the order
 * would be testing its own copy of it.
 */

import { assert, assertEquals } from "@std/assert";
import { FixedClock } from "@platform/clock.ts";
import { nullLogger } from "@platform/logger.ts";
import {
  type ApplicationId,
  asApplicationId,
  asBoardId,
  asFacetId,
  asPostingId,
  type BoardId,
  type Platform,
} from "@platform/ids.ts";
import type { Config } from "@platform/config.ts";
import type { Services } from "@web/services.ts";
import { createApp } from "@web/app.ts";
import { ApiTokenService } from "@auth/api-token.ts";
import type { ApiToken, ApiTokenRepo } from "@auth/api-token.ts";
import type {
  Board,
  BoardRegistry,
  BoardSource,
  FetchResult,
  PostingRepo,
  Snapshot,
  SnapshotRepo,
  SourcePosting,
} from "@domain/discovery/types.ts";
import type {
  BoardOutcome,
  CollectionReport,
  CollectionRun,
  CollectionRunRepo,
} from "@domain/discovery/coverage.ts";
import type { MatchCandidate, MatchRepo, SettingsRepo } from "@domain/discovery/matching.ts";
import {
  type ApplicationRepo,
  type ApplicationStatus,
  type ApplicationSummary,
  DEFAULT_GHOST_AFTER_DAYS,
  type EventSource,
} from "@domain/pipeline/types.ts";

const NOW = "2026-08-03T12:00:00Z";
const FACET_ID = "544b0c80-08b6-4b22-ab6c-9b3ad2028fc0";
const APPLICATION_ID = "50d3fc8f-f23e-403e-a633-5aeef8bfaeb6";

const CONFIG: Config = {
  env: "development",
  host: "127.0.0.1",
  port: 8000,
  baseUrl: "http://localhost:8000",
  contactUrl: "https://example.invalid/contact",
  databaseUrl: "postgres://unused",
  embeddingModel: "voyage-3.5",
  anthropicModel: "claude-opus-5",
  logLevel: "error",
  secureCookies: false,
};

/* ------------------------------------------------ fakes ------------------- */

class MemoryTokenRepo implements ApiTokenRepo {
  readonly rows: Array<{ token: ApiToken; hash: string }> = [];
  #next = 0;

  list(): Promise<ApiToken[]> {
    return Promise.resolve(this.rows.map((r) => r.token));
  }

  create(input: { label: string; tokenHash: string; tokenPrefix: string }): Promise<ApiToken> {
    const token: ApiToken = {
      id: `tok-${this.#next++}`,
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      createdAt: new Date(NOW),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.rows.push({ token, hash: input.tokenHash });
    return Promise.resolve(token);
  }

  findActiveByHash(hash: string): Promise<ApiToken | null> {
    const row = this.rows.find((r) => r.hash === hash && r.token.revokedAt === null);
    return Promise.resolve(row?.token ?? null);
  }

  revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.token.id === id);
    if (row !== undefined) row.token = { ...row.token, revokedAt: at };
    return Promise.resolve();
  }
}

function board(slug: string, name: string): Board {
  return {
    id: asBoardId(`greenhouse:${slug}`),
    platform: "greenhouse",
    slug,
    companyName: name,
    active: true,
    tags: [],
    addedAt: new Date(NOW),
    lastFetchStatus: "never",
    consecutiveFailures: 0,
  };
}

class FakeBoards implements BoardRegistry {
  constructor(private readonly boards: Board[]) {}
  list(): Promise<Board[]> {
    return Promise.resolve(this.boards);
  }
  get(id: BoardId): Promise<Board | null> {
    return Promise.resolve(this.boards.find((b) => b.id === id) ?? null);
  }
  upsert(): Promise<Board> {
    throw new Error("not used");
  }
  deactivate(): Promise<void> {
    return Promise.resolve();
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
  recordFetchOutcome(): Promise<void> {
    return Promise.resolve();
  }
}

const NOOP_POSTINGS: PostingRepo = {
  get: () => Promise.resolve(null),
  list: () => Promise.resolve({ postings: [], total: 0 }),
  upsertMany: () => Promise.resolve(),
  markUnlisted: () => Promise.resolve(),
  markListed: () => Promise.resolve(),
  touchLastSeen: () => Promise.resolve(),
  countByBoard: () => Promise.resolve(new Map()),
};

class FakeSnapshots implements SnapshotRepo {
  readonly saved: Snapshot[] = [];
  save(snapshot: Snapshot): Promise<void> {
    this.saved.push(snapshot);
    return Promise.resolve();
  }
  latestSuccessful(): Promise<Snapshot | null> {
    return Promise.resolve(null);
  }
  recentForBoard(): Promise<Snapshot[]> {
    return Promise.resolve([]);
  }
}

class FakeRuns implements CollectionRunRepo {
  finished: CollectionReport | null = null;
  start(): Promise<void> {
    return Promise.resolve();
  }
  finish(report: CollectionReport): Promise<void> {
    this.finished = report;
    return Promise.resolve();
  }
  recent(): Promise<CollectionRun[]> {
    return Promise.resolve([]);
  }
  get(): Promise<CollectionRun | null> {
    return Promise.resolve(null);
  }
  boardOutcomes(_runId: string): Promise<BoardOutcome[]> {
    return Promise.resolve(this.finished?.boards.slice() ?? []);
  }
}

function posting(externalId: string): SourcePosting {
  return {
    externalId,
    title: "Staff Engineer",
    locationRaw: "Remote — US",
    descriptionText: "We need someone who has run a fleet.",
    applyUrl: `https://boards.example.invalid/${externalId}`,
  };
}

/** A source that answers for some slugs and throws for others. */
function sourceThatFails(failingSlugs: ReadonlySet<string>): BoardSource {
  return {
    platform: "greenhouse" as Platform,
    adapterVersion: "test-1",
    fetchBoard(slug: string): Promise<FetchResult> {
      if (failingSlugs.has(slug)) {
        return Promise.reject(new Error(`503 from ${slug}`));
      }
      return Promise.resolve({
        sourceUrl: `https://boards.example.invalid/${slug}`,
        fetchedAt: new Date(NOW),
        postings: [posting(`${slug}-1`), posting(`${slug}-2`)],
      });
    },
  };
}

function candidate(externalId: string, score: number): MatchCandidate {
  return {
    postingId: asPostingId(`greenhouse:acme:${externalId}`),
    boardId: asBoardId("greenhouse:acme"),
    title: "Staff Engineer",
    companyName: "Acme",
    locationRaw: "Remote — US",
    currentlyListed: true,
    firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    fetchedAt: new Date("2026-08-02T00:00:00Z"),
    facetId: asFacetId(FACET_ID),
    facetName: "Platform engineering",
    score,
    matchedChunk: "…ran a fleet of 400 machines…",
    scoredAt: new Date("2026-08-02T00:00:00Z"),
  };
}

function fakeMatches(candidates: readonly MatchCandidate[]): MatchRepo {
  return {
    stalePairs: () => Promise.resolve([]),
    scorePair: () => Promise.resolve(null),
    refreshBestScores: () => Promise.resolve(),
    listCandidates: () => Promise.resolve(candidates.slice()),
    forPosting: () => Promise.resolve([]),
    allScores: () => Promise.resolve([]),
  };
}

/** Nothing configured: every reader falls back to its documented default. */
const EMPTY_SETTINGS: SettingsRepo = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};

class FakeApplications implements ApplicationRepo {
  readonly changes: Array<{ id: ApplicationId; to: ApplicationStatus; source?: EventSource }> = [];

  constructor(private readonly stale: readonly ApplicationSummary[]) {}

  list(): Promise<ApplicationSummary[]> {
    return Promise.resolve(this.stale.slice());
  }
  get(): Promise<null> {
    return Promise.resolve(null);
  }
  create(): Promise<never> {
    throw new Error("not used");
  }
  changeStatus(
    id: ApplicationId,
    to: ApplicationStatus,
    opts: { source?: EventSource; at: Date },
  ): Promise<void> {
    this.changes.push({ id, to, ...(opts.source === undefined ? {} : { source: opts.source }) });
    return Promise.resolve();
  }
  setNotes(): Promise<void> {
    return Promise.resolve();
  }
  addEvent(): Promise<void> {
    return Promise.resolve();
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
  findStale(): Promise<ApplicationSummary[]> {
    return Promise.resolve(this.stale.slice());
  }
  countByStatus(): Promise<Map<ApplicationStatus, number>> {
    return Promise.resolve(new Map());
  }
}

/**
 * The sweep also purges rows that can no longer authenticate anything — the one
 * scheduled thing in the application, so the housekeeping rides along.
 */
const HOUSEKEEPING = {
  sessions: { purgeExpired: () => Promise.resolve(2) } as unknown as Services["sessions"],
  passkeys: { purgeExpiredChallenges: () => Promise.resolve(3) } as unknown as Services["passkeys"],
};

/**
 * Anything the handler reaches for that the test did not provide is a failure,
 * not an `undefined` that silently changes the behaviour under test.
 */
function servicesWith(provided: Partial<Services>): Services {
  return new Proxy(provided as Services, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      throw new Error(`the handler reached for an unfaked service: ${String(prop)}`);
    },
  });
}

interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>;
  token: string;
  tokenId: string;
  tokens: ApiTokenService;
  runs: FakeRuns;
}

async function harness(provided: Partial<Services>): Promise<Harness> {
  const tokens = new ApiTokenService(new MemoryTokenRepo(), new FixedClock(NOW));
  const { plaintext, token } = await tokens.issue("n8n");
  const runs = provided.runs instanceof FakeRuns ? provided.runs : new FakeRuns();

  const services = servicesWith({
    apiTokens: tokens,
    clock: new FixedClock(NOW),
    logger: nullLogger,
    runs,
    ...provided,
  });
  const app = createApp({ config: CONFIG, services, logger: nullLogger });

  return {
    token: plaintext,
    tokenId: token.id,
    tokens,
    runs,
    request: async (path, init) => await app.request(path, init),
  };
}

function authed(token: string, method = "POST"): RequestInit {
  return { method, headers: { authorization: `Bearer ${token}` } };
}

function collectHarness(failing: readonly string[]): Promise<Harness> {
  const source = sourceThatFails(new Set(failing));
  return harness({
    boards: new FakeBoards([board("acme", "Acme"), board("globex", "Globex")]),
    postings: NOOP_POSTINGS,
    snapshots: new FakeSnapshots(),
    runs: new FakeRuns(),
    sourceFor: () => source,
  });
}

/* ------------------------------------------------ the guard --------------- */

Deno.test("a job route without a token is 401 and never touches the handler", async () => {
  // The services proxy throws on any access, so a 401 here also proves the
  // guard short-circuits before the handler runs.
  const app = await harness({});
  const res = await app.request("/api/jobs/collect", { method: "POST" });
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("www-authenticate"), "Bearer");
  assertEquals(await res.json(), { error: "unauthorized" });
});

Deno.test("a session cookie grants nothing on a job route", async () => {
  const app = await harness({});
  const res = await app.request("/api/jobs/collect", {
    method: "POST",
    headers: { cookie: "job_radar_session=whatever-a-browser-might-send" },
  });
  assertEquals(res.status, 401);
});

Deno.test("a wrong or revoked token is 401, and the response cannot tell them apart", async () => {
  const app = await collectHarness([]);
  const wrong = await app.request("/api/jobs/collect", authed("jrq_not-a-real-token"));
  assertEquals(wrong.status, 401);
  assertEquals(await wrong.json(), { error: "unauthorized" });

  assertEquals((await app.request("/api/jobs/collect", authed(app.token))).status, 200);
  await app.tokens.revoke(app.tokenId);
  const revoked = await app.request("/api/jobs/collect", authed(app.token));
  assertEquals(revoked.status, 401);
  assertEquals(await revoked.json(), { error: "unauthorized" });
});

Deno.test("a bearer token grants nothing outside the job routes", async () => {
  const app = await harness({});
  const res = await app.request("/boards", {
    headers: { authorization: `Bearer ${app.token}` },
  });
  // Redirected to the login page: the session middleware does not consult it.
  assertEquals(res.status, 302);
  assert((res.headers.get("location") ?? "").startsWith("/login?next="));
});

Deno.test("an unknown /api path needs a token too, and then does not exist", async () => {
  const app = await harness({});
  assertEquals((await app.request("/api/jobs/nope", { method: "POST" })).status, 401);

  const found = await app.request("/api/jobs/nope", authed(app.token));
  assertEquals(found.status, 404);
  assertEquals(await found.json(), { error: "not found" });
});

Deno.test("the health check stays public — it is the one route with no token", async () => {
  const app = await harness({});
  const res = await app.request("/healthz");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

/* ------------------------------------------------ status semantics -------- */

Deno.test("collect: every board readable is 200", async () => {
  const app = await collectHarness([]);
  const res = await app.request("/api/jobs/collect", authed(app.token));
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.boardsConfigured, 2);
  assertEquals(body.boardsFetched, 2);
  assertEquals(body.failures, []);
  assertEquals(body.postingsNew, 4);
});

Deno.test("collect: one failing board is 207 and names the board, not just a count", async () => {
  const app = await collectHarness(["globex"]);
  const res = await app.request("/api/jobs/collect", authed(app.token));
  assertEquals(res.status, 207);

  const body = await res.json();
  assertEquals(body.status, "partial");
  assertEquals(body.boardsConfigured, 2);
  assertEquals(body.boardsFetched, 1);
  assertEquals(body.boardsFailed, 1);
  assertEquals(body.failures.length, 1);
  assertEquals(body.failures[0].boardId, "greenhouse:globex");
  assert(String(body.failures[0].reason).includes("503"));
  // The board that worked is still collected — a failure must not abort a run.
  assertEquals(body.postingsNew, 2);
});

Deno.test("collect: every board failing is 500, because nothing partially worked", async () => {
  const app = await collectHarness(["acme", "globex"]);
  const res = await app.request("/api/jobs/collect", authed(app.token));
  assertEquals(res.status, 500);

  const body = await res.json();
  assertEquals(body.status, "failed");
  assertEquals(body.boardsFailed, 2);
  assertEquals(body.failures.length, 2);
});

Deno.test("collect: no boards configured is not a failure", async () => {
  const app = await harness({
    boards: new FakeBoards([]),
    postings: NOOP_POSTINGS,
    snapshots: new FakeSnapshots(),
    sourceFor: () => null,
  });
  const res = await app.request("/api/jobs/collect", authed(app.token));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
});

Deno.test("collect: the per-board breakdown is persisted with the run totals", async () => {
  const app = await collectHarness(["globex"]);
  await app.request("/api/jobs/collect", authed(app.token));

  const outcomes = await app.runs.boardOutcomes("ignored");
  assertEquals(outcomes.length, 2);
  const globex = outcomes.find((o) => o.boardId === "greenhouse:globex");
  assertEquals(globex?.status, "failed");
  assert((globex?.reason ?? "").includes("503"));
  const acme = outcomes.find((o) => o.boardId === "greenhouse:acme");
  assertEquals(acme?.status, "ok");
  assertEquals(acme?.appeared, 2);
});

Deno.test("digest: a match is described by bucket, never by a raw score", async () => {
  const app = await harness({
    matches: fakeMatches([candidate("acme-1", 0.83), candidate("acme-2", 0.44)]),
    settings: EMPTY_SETTINGS,
    boards: new FakeBoards([board("acme", "Acme")]),
  });
  const res = await app.request("/api/jobs/digest", authed(app.token, "GET"));
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.matches.length, 2);
  for (const match of body.matches) {
    assert(["strong", "plausible", "weak"].includes(match.bucket), match.bucket);
    assert(!("score" in match), "a cosine distance in a notification reads as a verdict (§7)");
  }
  // The verbatim passage travels with the match (§7) — a score with no evidence
  // is the thing this design exists to avoid.
  assert(String(body.matches[0].matchedPassage).length > 0);
  assertEquals(body.coverage.activeBoards, 1);
});

Deno.test("digest: `since` filters, and a malformed one is a 400 rather than everything", async () => {
  const app = await harness({
    matches: fakeMatches([candidate("acme-1", 0.83)]),
    settings: EMPTY_SETTINGS,
    boards: new FakeBoards([board("acme", "Acme")]),
  });
  const bad = await app.request("/api/jobs/digest?since=yesterday", authed(app.token, "GET"));
  assertEquals(bad.status, 400);

  const after = await app.request(
    "/api/jobs/digest?since=2030-01-01T00:00:00Z",
    authed(app.token, "GET"),
  );
  assertEquals((await after.json()).matches.length, 0);
});

Deno.test("digest: boards that could not be read are part of the answer", async () => {
  const readable: Board = {
    ...board("acme", "Acme"),
    lastFetchStatus: "ok",
    lastFetchAt: new Date("2026-08-03T06:00:00Z"),
  };
  const unreadable: Board = {
    ...board("globex", "Globex"),
    lastFetchStatus: "failed",
    lastFetchError: "503 Service Unavailable",
    consecutiveFailures: 3,
  };
  const app = await harness({
    matches: fakeMatches([]),
    settings: EMPTY_SETTINGS,
    boards: new FakeBoards([readable, unreadable]),
  });
  const body = await (await app.request("/api/jobs/digest", authed(app.token, "GET"))).json();
  assertEquals(body.coverage.activeBoards, 2);
  assertEquals(body.coverage.unreadableBoards.length, 1);
  assertEquals(body.coverage.unreadableBoards[0].company, "Globex");
  assertEquals(body.coverage.unreadableBoards[0].consecutiveFailures, 3);
});

Deno.test("sweep: stale applications are ghosted by rule, and the rule says so", async () => {
  const applications = new FakeApplications([
    {
      id: asApplicationId(APPLICATION_ID),
      postingId: asPostingId("greenhouse:acme:acme-1"),
      postingTitle: "Staff Engineer",
      companyName: "Acme",
      status: "sent",
      lastActivityAt: new Date("2026-06-01T00:00:00Z"),
      eventCount: 2,
    },
  ]);
  const app = await harness({ applications, settings: EMPTY_SETTINGS, ...HOUSEKEEPING });

  const res = await app.request("/api/jobs/sweep", authed(app.token));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.afterDays, DEFAULT_GHOST_AFTER_DAYS);
  assertEquals(body.ghosted.length, 1);
  assertEquals(body.ghosted[0].company, "Acme");
  assertEquals(body.purged, { sessions: 2, webauthnChallenges: 3 });

  assertEquals(applications.changes.length, 1);
  assertEquals(applications.changes[0]?.to, "ghosted");
  // Attributed to the rule, not to the user: a rule-set status is not an
  // observation about the employer.
  assertEquals(applications.changes[0]?.source, "rule");
});

Deno.test("sweep: nothing stale is still a 200 with an empty list", async () => {
  const applications = new FakeApplications([]);
  const app = await harness({ applications, settings: EMPTY_SETTINGS, ...HOUSEKEEPING });
  const res = await app.request("/api/jobs/sweep", authed(app.token));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ghosted, []);
  assertEquals(applications.changes.length, 0);
});

Deno.test("embed and match are 500 when no embedder is configured, not a silent no-op", async () => {
  const app = await harness({ embedder: null });
  for (const path of ["/api/jobs/embed", "/api/jobs/match"]) {
    const res = await app.request(path, authed(app.token));
    assertEquals(res.status, 500, path);
    assertEquals((await res.json()).status, "disabled");
  }
});
