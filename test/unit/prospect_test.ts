/**
 * The prospect queue: the paste parser, and the drain.
 *
 * No network and no Postgres — the repo is a port and here it is a Map, the
 * probe is a function that counts calls. What these tests are actually pinning
 * down is the distinction the whole design rests on: a platform saying "no
 * board" resolves a prospect, and a platform failing to answer does not.
 */

import { assertEquals } from "@std/assert";
import type { Clock } from "@platform/clock.ts";
import type { Platform } from "@platform/ids.ts";
import { createLogger } from "@platform/logger.ts";
import type { BoardSource, FetchResult } from "@domain/discovery/types.ts";
import {
  type BoardCandidate,
  type BoardCandidateRepo,
  ERROR_TTL_MS,
  HIT_TTL_MS,
  isFresh,
  MISS_TTL_MS,
} from "@domain/discovery/resolve.ts";
import {
  type ClaimedProspect,
  describeDrain,
  INTERACTIVE_PROSPECT_LIMIT,
  MAX_PASTED_PROSPECTS,
  MAX_PROSPECT_ATTEMPTS,
  type NewProspect,
  parseProspectList,
  type Prospect,
  type ProspectCounts,
  type ProspectOutcome,
  type ProspectQuery,
  type ProspectRepo,
  type ProspectReport,
  resolveProspects,
} from "@domain/discovery/prospect.ts";

/* ------------------------------------------------------ paste parsing ----- */

Deno.test("paste: one name per line, blanks and comments dropped", () => {
  assertEquals(
    parseProspectList("Ramp\n\n# from the a16z page\nLinear\n   \nVercel"),
    ["Ramp", "Linear", "Vercel"],
  );
});

Deno.test("paste: spreadsheet debris is stripped rather than rejected", () => {
  assertEquals(parseProspectList("Ramp,\n\"Linear\",\n'Vercel'"), ["Ramp", "Linear", "Vercel"]);
});

Deno.test("paste: deduplicated case-insensitively, first spelling kept", () => {
  // Both spellings generate identical slugs, so they are one question.
  assertEquals(parseProspectList("Stripe\nstripe\nSTRIPE"), ["Stripe"]);
});

Deno.test("paste: order is preserved, so a queue drains as it was pasted", () => {
  assertEquals(parseProspectList("C\nA\nB"), ["C", "A", "B"]);
});

Deno.test("paste: bounded, and absurd lines are skipped not truncated", () => {
  const many = Array.from({ length: MAX_PASTED_PROSPECTS + 50 }, (_, i) => `co-${i}`).join("\n");
  assertEquals(parseProspectList(many).length, MAX_PASTED_PROSPECTS);
  assertEquals(parseProspectList(`${"x".repeat(201)}\nRamp`), ["Ramp"]);
});

Deno.test("paste: nothing usable yields nothing", () => {
  assertEquals(parseProspectList(""), []);
  assertEquals(parseProspectList("\n\n# only a comment\n"), []);
});

/* ---------------------------------------------------------- freshness ----- */

Deno.test("freshness: an error is not cached as though it were a miss", () => {
  const now = new Date("2026-08-06T00:00:00Z");
  const at = (msAgo: number): BoardCandidate => ({
    platform: "greenhouse",
    slug: "esri",
    found: false,
    error: "Upstream error (503).",
    checkedAt: new Date(now.getTime() - msAgo),
  });

  // Short enough not to hammer a struggling upstream...
  assertEquals(isFresh(at(ERROR_TTL_MS - 1000), now), true);
  // ...but nowhere near the week a clean miss would have been trusted for.
  assertEquals(isFresh(at(ERROR_TTL_MS + 1000), now), false);
  assertEquals(isFresh(at(HIT_TTL_MS), now), false);
  assertEquals(isFresh(at(MISS_TTL_MS - 1000), now), false);
});

/* -------------------------------------------------------------- fakes ----- */

class FakeCandidates implements BoardCandidateRepo {
  readonly stored = new Map<string, BoardCandidate>();
  lookup(pairs: readonly { platform: Platform; slug: string }[]): Promise<BoardCandidate[]> {
    return Promise.resolve(
      pairs
        .map((pair) => this.stored.get(`${pair.platform}:${pair.slug}`))
        .filter((c): c is BoardCandidate => c !== undefined),
    );
  }
  record(candidate: BoardCandidate): Promise<void> {
    this.stored.set(`${candidate.platform}:${candidate.slug}`, candidate);
    return Promise.resolve();
  }
  recent(): Promise<BoardCandidate[]> {
    return Promise.resolve([...this.stored.values()]);
  }
}

/** A mutable row, because the queue is the one place state actually changes. */
interface QueueRow {
  query: string;
  source?: string;
  enqueuedAt: Date;
  resolvedAt?: Date;
  attempts: number;
  hits?: number;
  lastError?: string;
  startedAt?: Date;
}

/** The queue as a Map, with the same lease and attempt rules as the table. */
class FakeProspects implements ProspectRepo {
  readonly rows = new Map<string, QueueRow>();

  constructor(names: readonly string[] = []) {
    for (const query of names) {
      this.rows.set(query, { query, enqueuedAt: new Date(0), attempts: 0 });
    }
  }

  enqueue(entries: readonly NewProspect[]): Promise<number> {
    let added = 0;
    for (const entry of entries) {
      const existing = [...this.rows.keys()].some(
        (key) => key.toLowerCase() === entry.query.toLowerCase(),
      );
      if (existing) continue;
      this.rows.set(entry.query, {
        query: entry.query,
        enqueuedAt: new Date(0),
        attempts: 0,
        ...(entry.source !== undefined ? { source: entry.source } : {}),
      });
      added++;
    }
    return Promise.resolve(added);
  }

  claim(
    limit: number,
    opts: { now: Date; leaseCutoff: Date; maxAttempts: number },
  ): Promise<ClaimedProspect[]> {
    const claimed: ClaimedProspect[] = [];
    for (const row of this.rows.values()) {
      if (claimed.length === limit) break;
      if (row.resolvedAt !== undefined) continue;
      if (row.attempts >= opts.maxAttempts) continue;
      if (row.startedAt !== undefined && row.startedAt >= opts.leaseCutoff) continue;
      row.attempts++;
      row.startedAt = opts.now;
      claimed.push({
        query: row.query,
        attempts: row.attempts,
        ...(row.source !== undefined ? { source: row.source } : {}),
      });
    }
    return Promise.resolve(claimed);
  }

  settle(query: string, outcome: ProspectOutcome): Promise<void> {
    const row = this.rows.get(query);
    if (row === undefined) return Promise.resolve();
    delete row.startedAt;
    if (outcome.kind === "resolved") {
      this.rows.set(query, {
        ...row,
        resolvedAt: outcome.at,
        hits: outcome.hits,
        ...(outcome.note !== undefined ? { lastError: outcome.note } : {}),
      });
    } else {
      this.rows.set(query, { ...row, lastError: outcome.reason });
    }
    return Promise.resolve();
  }

  release(queries: readonly string[]): Promise<void> {
    for (const query of queries) {
      const row = this.rows.get(query);
      if (row === undefined || row.resolvedAt !== undefined) continue;
      delete row.startedAt;
      row.attempts = Math.max(row.attempts - 1, 0);
    }
    return Promise.resolve();
  }

  counts(maxAttempts: number): Promise<ProspectCounts> {
    const all = [...this.rows.values()];
    return Promise.resolve({
      pending: all.filter((r) => r.resolvedAt === undefined && r.attempts < maxAttempts).length,
      resolved: all.filter((r) => r.resolvedAt !== undefined).length,
      stuck: all.filter((r) => r.resolvedAt === undefined && r.attempts >= maxAttempts).length,
    });
  }

  list(query: ProspectQuery): Promise<Prospect[]> {
    const all = [...this.rows.values()];
    const rows = query.pendingOnly === true ? all.filter((r) => r.resolvedAt === undefined) : all;
    return Promise.resolve(rows.slice(0, query.limit));
  }

  clearResolved(): Promise<number> {
    let cleared = 0;
    for (const [key, row] of this.rows) {
      if (row.resolvedAt === undefined) continue;
      this.rows.delete(key);
      cleared++;
    }
    return Promise.resolve(cleared);
  }
}

const NOW = new Date("2026-08-06T12:00:00Z");
const logger = createLogger("error", {});

function fixedClock(): Clock {
  return { now: () => NOW };
}

const board: BoardSource = {
  platform: "greenhouse",
  adapterVersion: "test/1",
  fetchBoard: (): Promise<FetchResult> =>
    Promise.resolve({
      sourceUrl: "https://example.invalid/board",
      fetchedAt: NOW,
      postings: [{
        externalId: "1",
        title: "Engineer",
        locationRaw: "",
        descriptionText: "",
        applyUrl: "https://example.invalid/apply",
      }],
    }),
};

const threePlatforms = (platform: Platform) =>
  (["greenhouse", "lever", "ashby"] as string[]).includes(platform) ? board : null;

function deps(prospects: FakeProspects, probe: Parameters<typeof resolveProspects>[0]["probe"]) {
  return {
    prospects,
    candidates: new FakeCandidates(),
    probe,
    sourceFor: threePlatforms,
    clock: fixedClock(),
    logger,
  };
}

/* ------------------------------------------------------------- drains ----- */

Deno.test("drain: a found board is reported with the company's own name", async () => {
  const prospects = new FakeProspects(["Esri"]);
  const report = await resolveProspects(deps(prospects, (platform, slug) =>
    Promise.resolve(
      platform === "greenhouse" && slug === "esri"
        ? { found: true, companyName: "Esri" }
        : { found: false },
    )));

  assertEquals(report.claimed, 1);
  assertEquals(report.resolved, 1);
  assertEquals(report.hits.length, 1);
  assertEquals(report.hits[0]?.platform, "greenhouse");
  assertEquals(report.hits[0]?.slug, "esri");
  assertEquals(report.hits[0]?.companyName, "Esri");
  // Read by the real adapter, so the count is the adapter's, not the probe's.
  assertEquals(report.hits[0]?.postingCount, 1);
  assertEquals(report.counts.pending, 0);
});

Deno.test("drain: no board anywhere resolves the prospect rather than retrying it", async () => {
  const prospects = new FakeProspects(["Walmart"]);
  const report = await resolveProspects(deps(prospects, () => Promise.resolve({ found: false })));

  assertEquals(report.resolved, 1);
  assertEquals(report.deferred, 0);
  assertEquals(report.empty, ["Walmart"]);
  assertEquals(prospects.rows.get("Walmart")?.hits, 0);
  // The whole point: asking again next run would learn the same nothing.
  assertEquals(report.counts.pending, 0);
});

Deno.test("drain: a failure to find out leaves the prospect pending", async () => {
  const prospects = new FakeProspects(["Ramp"]);
  const report = await resolveProspects(
    deps(prospects, () => Promise.resolve({ found: false, error: "Upstream error (503)." })),
  );

  assertEquals(report.resolved, 0);
  assertEquals(report.deferred, 1);
  assertEquals(report.failures[0]?.query, "Ramp");
  assertEquals(prospects.rows.get("Ramp")?.resolvedAt, undefined);
  // Still pending, and the lease released so the next run can take it.
  assertEquals(report.counts.pending, 1);
  assertEquals(prospects.rows.get("Ramp")?.startedAt, undefined);
});

Deno.test("drain: a hit on one platform outweighs an error on another", async () => {
  const prospects = new FakeProspects(["Linear"]);
  const report = await resolveProspects(deps(prospects, (platform) =>
    Promise.resolve(
      platform === "greenhouse"
        ? { found: true }
        : { found: false, error: "Upstream error (500)." },
    )));

  // A board was found. That is an answer, whatever else was flaky alongside it.
  assertEquals(report.resolved, 1);
  assertEquals(report.deferred, 0);
  assertEquals(report.hits.length, 1);
});

Deno.test("drain: one failing prospect never aborts the run", async () => {
  const prospects = new FakeProspects(["Boom", "Esri"]);
  const report = await resolveProspects(deps(prospects, (_platform, slug) => {
    if (slug.startsWith("boom")) throw new Error("adapter exploded");
    return Promise.resolve({ found: slug === "esri" });
  }));

  assertEquals(report.claimed, 2);
  assertEquals(report.deferred, 1);
  assertEquals(report.resolved, 1);
  // The name behind the failure still got asked.
  assertEquals(report.hits[0]?.slug, "esri");
});

Deno.test("drain: text with no slug in it resolves permanently, not as a failure", async () => {
  const prospects = new FakeProspects(["!!!"]);
  let asked = 0;
  const report = await resolveProspects(deps(prospects, () => {
    asked++;
    return Promise.resolve({ found: false });
  }));

  assertEquals(asked, 0, "there was never a question to ask");
  assertEquals(report.resolved, 1);
  assertEquals(report.deferred, 0);
  assertEquals(prospects.rows.get("!!!")?.resolvedAt, NOW);
});

Deno.test("drain: the slice is bounded, and the rest stays queued", async () => {
  const prospects = new FakeProspects(["A Co", "B Co", "C Co", "D Co"]);
  const report = await resolveProspects(
    deps(prospects, () => Promise.resolve({ found: false })),
    { limit: 2 },
  );

  assertEquals(report.claimed, 2);
  assertEquals(report.counts.pending, 2);
});

Deno.test("drain: the deadline stops the run on a prospect boundary", async () => {
  const prospects = new FakeProspects(["A Co", "B Co", "C Co"]);
  // A clock that jumps a minute per reading, so the budget is spent immediately.
  let ticks = 0;
  const clock: Clock = { now: () => new Date(NOW.getTime() + ticks++ * 60_000) };

  const report = await resolveProspects({
    ...deps(prospects, () => Promise.resolve({ found: false })),
    clock,
  }, { deadlineMs: 30_000 });

  assertEquals(report.stoppedEarly, true);
  // The first is always attempted — a run that claims work must do some of it.
  assertEquals(report.resolved, 1);
  assertEquals(report.claimed, 3);

  // The two it never got to are back exactly as they were: no lease, and no
  // attempt spent. Otherwise three deadline-stopped runs would retire a name
  // as stuck without a single request having been made about it.
  for (const query of ["B Co", "C Co"]) {
    assertEquals(prospects.rows.get(query)?.startedAt, undefined, query);
    assertEquals(prospects.rows.get(query)?.attempts, 0, query);
  }
  assertEquals(report.counts.pending, 2);
});

Deno.test("drain: a released prospect is picked up by the very next run", async () => {
  const prospects = new FakeProspects(["A Co", "B Co"]);
  let ticks = 0;
  const impatient: Clock = { now: () => new Date(NOW.getTime() + ticks++ * 60_000) };
  const probe = () => Promise.resolve({ found: false });

  const first = await resolveProspects(
    { ...deps(prospects, probe), clock: impatient },
    { deadlineMs: 30_000 },
  );
  assertEquals(first.stoppedEarly, true);
  assertEquals(first.resolved, 1);

  // No waiting on the lease to expire: the release put it straight back.
  const second = await resolveProspects(deps(prospects, probe));
  assertEquals(second.claimed, 1);
  assertEquals(second.resolved, 1);
  assertEquals(second.counts.pending, 0);
});

Deno.test("drain: a prospect out of attempts stops being claimed", async () => {
  const prospects = new FakeProspects(["Flaky Co"]);
  const failing = deps(
    prospects,
    () => Promise.resolve({ found: false, error: "Upstream error (503)." }),
  );

  for (let run = 0; run < MAX_PROSPECT_ATTEMPTS; run++) {
    const report = await resolveProspects(failing);
    assertEquals(report.deferred, 1, `run ${run}`);
  }

  const final = await resolveProspects(failing);
  assertEquals(final.claimed, 0);
  // Not silently dropped: it is counted as stuck so the queue does not look
  // empty when it has simply stopped moving.
  assertEquals(final.counts.pending, 0);
  assertEquals(final.counts.stuck, 1);
});

Deno.test("drain: an empty queue is a clean run, not a partial one", async () => {
  const report = await resolveProspects(
    deps(new FakeProspects(), () => Promise.resolve({ found: false })),
  );
  assertEquals(report.claimed, 0);
  assertEquals(report.counts.pending, 0);
  assertEquals(report.stoppedEarly, false);
});

Deno.test("queue: re-pasting an overlapping list only adds what is new", async () => {
  const prospects = new FakeProspects();
  assertEquals(await prospects.enqueue([{ query: "Ramp" }, { query: "Linear" }]), 2);
  assertEquals(await prospects.enqueue([{ query: "ramp" }, { query: "Vercel" }]), 1);
});

Deno.test("queue: clearing keeps pending work and drops what was asked", async () => {
  const prospects = new FakeProspects(["Esri", "Ramp"]);
  await resolveProspects(
    deps(prospects, (_platform, slug) => Promise.resolve({ found: slug === "esri" })),
    { limit: 1 },
  );

  assertEquals(await prospects.clearResolved(), 1);
  assertEquals([...prospects.rows.keys()], ["Ramp"]);
});

/* -------------------------------------------- describing a hand drain ----- */

/** The interactive drain reports through this, so its branches are the contract. */
function reportWith(over: Partial<ProspectReport>): ProspectReport {
  return {
    claimed: 0,
    resolved: 0,
    deferred: 0,
    hits: [],
    empty: [],
    failures: [],
    stoppedEarly: false,
    counts: { pending: 0, resolved: 0, stuck: 0 },
    ...over,
  };
}

Deno.test("describe: an empty queue says so rather than reporting a run", () => {
  assertEquals(describeDrain(reportWith({})), "Nothing in the queue to ask about.");
});

Deno.test("describe: found boards are counted, and one board is singular", () => {
  const hit = {
    query: "Esri",
    platform: "greenhouse" as Platform,
    slug: "esri",
  };
  assertEquals(
    describeDrain(reportWith({ claimed: 1, resolved: 1, hits: [hit] })),
    "Asked about 1 name · found 1 board",
  );
  assertEquals(
    describeDrain(reportWith({ claimed: 2, resolved: 2, hits: [hit, { ...hit, slug: "esrihq" }] })),
    "Asked about 2 names · found 2 boards",
  );
});

Deno.test("describe: finding nothing does not read as failing to ask", () => {
  assertEquals(
    describeDrain(reportWith({ claimed: 3, resolved: 3 })),
    "Asked about 3 names · found no boards",
  );
});

Deno.test("describe: unreachable names are named apart from boards that do not exist", () => {
  const message = describeDrain(
    reportWith({
      claimed: 3,
      resolved: 2,
      deferred: 1,
      counts: { pending: 1, resolved: 2, stuck: 0 },
    }),
  );
  assertEquals(
    message,
    "Asked about 3 names · found no boards · 1 name could not be reached and stayed queued · " +
      "1 still queued — ask again to continue",
  );
});

Deno.test("describe: a remaining backlog invites another click, so a bound is not a bug", () => {
  const message = describeDrain(
    reportWith({
      claimed: INTERACTIVE_PROSPECT_LIMIT,
      resolved: INTERACTIVE_PROSPECT_LIMIT,
      counts: { pending: 40, resolved: INTERACTIVE_PROSPECT_LIMIT, stuck: 0 },
    }),
  );
  assertEquals(message.endsWith("40 still queued — ask again to continue"), true, message);
});
