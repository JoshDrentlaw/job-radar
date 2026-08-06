/**
 * Board resolution: the slug guesser, the URL reader, and the use case that
 * asks. No network — the probe is a port, and here it is a function that counts
 * how many times it was called, because request count is the thing this design
 * is actually trading against.
 */

import { assertEquals } from "@std/assert";
import type { Clock } from "@platform/clock.ts";
import type { Platform } from "@platform/ids.ts";
import { createLogger } from "@platform/logger.ts";
import type { BoardSource, FetchResult } from "@domain/discovery/types.ts";
import {
  type BoardCandidate,
  type BoardCandidateRepo,
  candidateSlugs,
  HIT_TTL_MS,
  isFresh,
  MISS_TTL_MS,
  parseBoardUrl,
  resolveBoards,
} from "@domain/discovery/resolve.ts";

const slugs = (name: string) => candidateSlugs(name).map((c) => c.slug);

/* ------------------------------------------------------ slug guessing ----- */

Deno.test("candidates: a single word yields itself and the hq variant", () => {
  assertEquals(slugs("Esri"), ["esri", "esrihq"]);
});

Deno.test("candidates: two words are joined, hyphenated, then truncated", () => {
  assertEquals(slugs("Data Dog"), ["datadog", "data-dog", "data", "datadoghq"]);
});

Deno.test("candidates: legal suffixes are dropped from the end", () => {
  assertEquals(slugs("Esri Inc."), ["esri", "esrihq"]);
  assertEquals(slugs("Acme Holdings Ltd"), ["acme", "acmehq"]);
});

Deno.test("candidates: a suffix-looking word is kept when it is the whole name", () => {
  // "Co-op" must not become "op".
  assertEquals(slugs("Co-op")[0], "coop");
  assertEquals(slugs("Group")[0], "group");
});

Deno.test("candidates: diacritics fold to ASCII", () => {
  assertEquals(slugs("Estée Lauder")[0], "esteelauder");
});

Deno.test("candidates: apostrophes are removed, not split on", () => {
  assertEquals(slugs("Ben & Jerry's").slice(0, 2), ["benjerrys", "ben-jerrys"]);
});

Deno.test("candidates: never more than four, and never duplicated", () => {
  for (const name of ["A B C D E F", "Esri", "The Very Long Company Name Ltd"]) {
    const generated = slugs(name);
    assertEquals(generated.length <= 4, true, `${name} produced ${generated.length}`);
    assertEquals(new Set(generated).size, generated.length, `${name} produced duplicates`);
  }
});

Deno.test("candidates: a name with nothing sluggable yields nothing at all", () => {
  assertEquals(slugs("!!!"), []);
  assertEquals(slugs("   "), []);
});

/* --------------------------------------------------------- URL reading ---- */

Deno.test("parseBoardUrl: the board URLs a person actually has to hand", () => {
  const cases: [string, Platform, string][] = [
    ["https://boards.greenhouse.io/esri", "greenhouse", "esri"],
    ["https://job-boards.greenhouse.io/vercel", "greenhouse", "vercel"],
    ["https://boards-api.greenhouse.io/v1/boards/figma/jobs", "greenhouse", "figma"],
    ["https://jobs.lever.co/spotify", "lever", "spotify"],
    ["https://api.lever.co/v0/postings/veeva?mode=json", "lever", "veeva"],
    ["https://jobs.ashbyhq.com/linear", "ashby", "linear"],
    ["https://api.ashbyhq.com/posting-api/job-board/ramp", "ashby", "ramp"],
    // No scheme is the normal way a URL gets pasted.
    ["boards.greenhouse.io/esri", "greenhouse", "esri"],
    // Trailing path and query are ignored.
    ["https://jobs.lever.co/spotify/1234-abcd", "lever", "spotify"],
  ];
  for (const [input, platform, slug] of cases) {
    assertEquals(parseBoardUrl(input), { platform, slug }, input);
  }
});

Deno.test("parseBoardUrl: anything that is not a known board URL is a company name", () => {
  for (
    const input of [
      "Esri",
      "https://example.com/careers",
      "https://greenhouse.io", // the vendor's own site, no board
      "https://boards.greenhouse.io/", // no slug
      "not a url at all",
    ]
  ) {
    assertEquals(parseBoardUrl(input), null, input);
  }
});

Deno.test("parseBoardUrl: a slug that would be an invalid id is refused", () => {
  assertEquals(parseBoardUrl("https://boards.greenhouse.io/..%2F..%2Fetc"), null);
});

/* ---------------------------------------------------------- freshness ----- */

Deno.test("freshness: a miss is trusted for longer than a hit", () => {
  const now = new Date("2026-08-06T00:00:00Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const hit = (msAgo: number): BoardCandidate => ({
    platform: "greenhouse",
    slug: "esri",
    found: true,
    checkedAt: at(msAgo),
  });
  const miss = (msAgo: number): BoardCandidate => ({ ...hit(msAgo), found: false });

  assertEquals(isFresh(hit(HIT_TTL_MS - 1000), now), true);
  assertEquals(isFresh(hit(HIT_TTL_MS + 1000), now), false);
  // The same age that has expired a hit is still fresh for a miss.
  assertEquals(isFresh(miss(HIT_TTL_MS + 1000), now), true);
  assertEquals(isFresh(miss(MISS_TTL_MS + 1000), now), false);
});

/* ----------------------------------------------------------- use case ----- */

class FakeCandidates implements BoardCandidateRepo {
  readonly stored = new Map<string, BoardCandidate>();
  readonly recorded: BoardCandidate[] = [];

  seed(candidate: BoardCandidate): void {
    this.stored.set(`${candidate.platform}:${candidate.slug}`, candidate);
  }
  lookup(pairs: readonly { platform: Platform; slug: string }[]): Promise<BoardCandidate[]> {
    const hits = pairs
      .map((pair) => this.stored.get(`${pair.platform}:${pair.slug}`))
      .filter((c): c is BoardCandidate => c !== undefined);
    return Promise.resolve(hits);
  }
  record(candidate: BoardCandidate): Promise<void> {
    this.recorded.push(candidate);
    this.stored.set(`${candidate.platform}:${candidate.slug}`, candidate);
    return Promise.resolve();
  }
  recent(): Promise<BoardCandidate[]> {
    return Promise.resolve([...this.stored.values()]);
  }
}

const NOW = new Date("2026-08-06T12:00:00Z");
const clock: Clock = { now: () => NOW };
const logger = createLogger("error", {});

function source(titles: string[]): BoardSource {
  return {
    platform: "greenhouse",
    adapterVersion: "test/1",
    fetchBoard: (): Promise<FetchResult> =>
      Promise.resolve({
        sourceUrl: "https://example.invalid/board",
        fetchedAt: NOW,
        postings: titles.map((title, index) => ({
          externalId: String(index),
          title,
          locationRaw: "",
          descriptionText: "",
          applyUrl: "https://example.invalid/apply",
        })),
      }),
  };
}

/** Only the three implemented platforms answer; everything else has no adapter. */
function threePlatforms(titles: string[] = ["Engineer", "Designer", "Analyst", "Intern"]) {
  const implemented: ReadonlySet<string> = new Set(["greenhouse", "lever", "ashby"]);
  return (platform: Platform) => (implemented.has(platform) ? source(titles) : null);
}

Deno.test("resolve: a hit is described by the real adapter, not by the probe", async () => {
  const candidates = new FakeCandidates();
  const asked: string[] = [];

  const report = await resolveBoards("Esri", {
    candidates,
    probe: (platform, slug) => {
      asked.push(`${platform}:${slug}`);
      return Promise.resolve(
        platform === "greenhouse" && slug === "esri"
          ? { found: true, companyName: "Esri" }
          : { found: false },
      );
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  const hit = report.results.find((r) => r.found);
  assertEquals(hit?.platform, "greenhouse");
  assertEquals(hit?.slug, "esri");
  // The name came from the platform; the count and titles from the adapter.
  assertEquals(hit?.companyName, "Esri");
  assertEquals(hit?.postingCount, 4);
  assertEquals(hit?.sampleTitles, ["Engineer", "Designer", "Analyst"]);
  assertEquals(report.interpretedAs, "company-name");
  assertEquals(report.fromCache, false);
});

Deno.test("resolve: a platform stops asking once it has a hit", async () => {
  const candidates = new FakeCandidates();
  const asked: string[] = [];

  await resolveBoards("Esri", {
    candidates,
    probe: (platform, slug) => {
      asked.push(`${platform}:${slug}`);
      return Promise.resolve({ found: platform === "greenhouse" && slug === "esri" });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  // Greenhouse hit on the first candidate, so `esrihq` was never asked of it.
  assertEquals(asked.includes("greenhouse:esri"), true);
  assertEquals(asked.includes("greenhouse:esrihq"), false);
  // The platforms that missed were asked about both candidates.
  assertEquals(asked.includes("lever:esri"), true);
  assertEquals(asked.includes("lever:esrihq"), true);
});

Deno.test("resolve: a pasted URL asks exactly one question", async () => {
  const candidates = new FakeCandidates();
  const asked: string[] = [];

  const report = await resolveBoards("https://jobs.lever.co/spotify", {
    candidates,
    probe: (platform, slug) => {
      asked.push(`${platform}:${slug}`);
      return Promise.resolve({ found: true });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  assertEquals(asked, ["lever:spotify"]);
  assertEquals(report.interpretedAs, "url");
  assertEquals(report.tried, [{ slug: "spotify", rule: "as-typed" }]);
});

Deno.test("resolve: a fresh cached answer is reused without asking", async () => {
  const candidates = new FakeCandidates();
  candidates.seed({
    platform: "greenhouse",
    slug: "esri",
    found: true,
    companyName: "Esri",
    postingCount: 431,
    checkedAt: new Date(NOW.getTime() - 60_000),
  });
  for (const platform of ["lever", "ashby"] as Platform[]) {
    for (const slug of ["esri", "esrihq"]) {
      candidates.seed({
        platform,
        slug,
        found: false,
        checkedAt: new Date(NOW.getTime() - 60_000),
      });
    }
  }

  let asked = 0;
  const report = await resolveBoards("Esri", {
    candidates,
    probe: () => {
      asked++;
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  assertEquals(asked, 0);
  assertEquals(report.fromCache, true);
  assertEquals(report.results.find((r) => r.found)?.postingCount, 431);
});

Deno.test("resolve: refresh ignores the cache", async () => {
  const candidates = new FakeCandidates();
  candidates.seed({
    platform: "greenhouse",
    slug: "esri",
    found: true,
    checkedAt: new Date(NOW.getTime() - 60_000),
  });

  let asked = 0;
  await resolveBoards("Esri", {
    candidates,
    probe: () => {
      asked++;
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  }, { refresh: true });

  assertEquals(asked > 0, true);
});

Deno.test("resolve: a stale answer is asked again", async () => {
  const candidates = new FakeCandidates();
  candidates.seed({
    platform: "greenhouse",
    slug: "esri",
    found: true,
    checkedAt: new Date(NOW.getTime() - HIT_TTL_MS - 1000),
  });

  const asked: string[] = [];
  await resolveBoards("Esri", {
    candidates,
    probe: (platform, slug) => {
      asked.push(`${platform}:${slug}`);
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  assertEquals(asked.includes("greenhouse:esri"), true);
});

Deno.test("resolve: a board we cannot read is a hit that says why", async () => {
  const candidates = new FakeCandidates();
  const broken: BoardSource = {
    platform: "greenhouse",
    adapterVersion: "test/1",
    fetchBoard: () => Promise.reject(new Error("Posting missing a required field")),
  };

  const report = await resolveBoards("Esri", {
    candidates,
    probe: (platform) => Promise.resolve({ found: platform === "greenhouse" }),
    sourceFor: (platform) => (platform === "greenhouse" ? broken : null),
    clock,
    logger,
  });

  const hit = report.results.find((r) => r.platform === "greenhouse");
  assertEquals(hit?.found, true);
  assertEquals(hit?.postingCount, undefined);
  assertEquals(hit?.error, "Posting missing a required field");
});

Deno.test("resolve: a probe that failed is not recorded as 'no board here'", async () => {
  const candidates = new FakeCandidates();
  const report = await resolveBoards("Esri", {
    candidates,
    probe: () => Promise.resolve({ found: false, error: "Upstream error (503)." }),
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  for (const result of report.results) {
    assertEquals(result.found, false);
    assertEquals(result.error, "Upstream error (503).");
  }
  // Recorded, so the page can distinguish it from a clean miss.
  assertEquals(candidates.recorded.every((c) => c.error !== undefined), true);
});

Deno.test("resolve: hits sort ahead of failures, which sort ahead of clean misses", async () => {
  const candidates = new FakeCandidates();
  const report = await resolveBoards("Esri", {
    candidates,
    probe: (platform) => {
      if (platform === "ashby") return Promise.resolve({ found: true });
      if (platform === "lever") return Promise.resolve({ found: false, error: "timed out" });
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  const order = report.results.map((r) => r.platform);
  assertEquals(order[0], "ashby");
  assertEquals(order.indexOf("lever") < order.indexOf("greenhouse"), true);
});

Deno.test("resolve: a name with nothing sluggable asks nothing", async () => {
  const candidates = new FakeCandidates();
  let asked = 0;
  const report = await resolveBoards("!!!", {
    candidates,
    probe: () => {
      asked++;
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  assertEquals(asked, 0);
  assertEquals(report.tried, []);
  assertEquals(report.results, []);
});

Deno.test("resolve: platforms with no adapter are never probed", async () => {
  const candidates = new FakeCandidates();
  const asked: Platform[] = [];
  await resolveBoards("Esri", {
    candidates,
    probe: (platform) => {
      asked.push(platform);
      return Promise.resolve({ found: false });
    },
    sourceFor: threePlatforms(),
    clock,
    logger,
  });

  assertEquals(new Set(asked), new Set<Platform>(["greenhouse", "lever", "ashby"]));
});
