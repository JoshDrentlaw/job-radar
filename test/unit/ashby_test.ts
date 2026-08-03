/**
 * Ashby parser tests. The fixture is live data from Ramp's and OpenAI's boards
 * (August 2026), trimmed at tag boundaries — real shapes, not invented ones.
 * The one synthetic case (the compensationTiers fallback) is labelled as such:
 * it was never observed live, and exists because the brief warns the nesting
 * is inconsistent across boards.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { ashbyBoardUrl, parseAshbyBoard, parseAshbyCompensation } from "@adapters/ats/ashby.ts";
import { FetchFailure } from "@adapters/ats/http.ts";
import fixture from "../fixtures/ashby-board.json" with { type: "json" };

const SOURCE_URL = ashbyBoardUrl("ramp");

Deno.test("ashby: url asks for compensation", () => {
  assertEquals(
    ashbyBoardUrl("ramp"),
    "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true",
  );
});

Deno.test("ashby: parses live fixture postings", () => {
  const postings = parseAshbyBoard(fixture, SOURCE_URL);
  assertEquals(postings.length, 3);

  const [first, second] = postings;
  assertEquals(first!.externalId, "34413f8d-26bf-4bbc-8ade-eb309a0e2245");
  // The live title had a leading space; whitespace is trimmed, content is not.
  assertEquals(first!.title, "Security Engineer, Cloud");
  assertEquals(first!.workplaceRaw, "Hybrid");
  assertEquals(first!.employmentType, "FullTime");
  assertEquals(first!.department, "Engineering");
  assertEquals(
    first!.locationRaw,
    "New York, NY (HQ) | Remote (Canada) | Remote (US) | Miami, FL",
  );
  assertEquals(
    first!.applyUrl,
    "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  );
  assertStringIncludes(first!.descriptionText, "# **About Ramp**");

  // workplaceType was null and compensation empty on this posting — both unset.
  assertEquals(second!.workplaceRaw, undefined);
  assertEquals(second!.compensation, undefined);
  assertEquals(second!.locationRaw, "Tokyo, Japan");
});

Deno.test("ashby: salary becomes the structured range, the summary stays verbatim", () => {
  const postings = parseAshbyBoard(fixture, SOURCE_URL);

  assertEquals(postings[0]!.compensation, {
    minAmount: 211400,
    maxAmount: 290600,
    currency: "USD",
    interval: "year",
    raw: "$211.4K – $290.6K • Offers Equity",
  });

  // This posting's Commission and EquityCashValue components have no
  // currencyCode key at all (observed live). Only the Salary component is
  // read structurally; the rest is covered by the source's own summary.
  assertEquals(postings[2]!.compensation, {
    minAmount: 131000,
    maxAmount: 191000,
    currency: "USD",
    interval: "year",
    raw: "$131K – $191K • Offers Equity • Offers Commission • Multiple Ranges",
  });
});

Deno.test("ashby: compensation falls back to tier components (synthetic — never observed live)", () => {
  const comp = parseAshbyCompensation({
    compensationTierSummary: "$100K – $120K",
    summaryComponents: [],
    compensationTiers: [
      {
        components: [
          {
            compensationType: "Salary",
            interval: "1 YEAR",
            currencyCode: "USD",
            minValue: 100000,
            maxValue: 110000,
          },
        ],
      },
      {
        components: [
          {
            compensationType: "Salary",
            interval: "1 YEAR",
            currencyCode: "USD",
            minValue: 105000,
            maxValue: 120000,
          },
        ],
      },
    ],
  });
  // The widest range across published tiers, never a tier picked silently.
  assertEquals(comp, {
    minAmount: 100000,
    maxAmount: 120000,
    currency: "USD",
    interval: "year",
    raw: "$100K – $120K",
  });
});

Deno.test("ashby: a summary with no recognizable structure still yields raw", () => {
  assertEquals(
    parseAshbyCompensation({ compensationTierSummary: "Competitive", summaryComponents: [] }),
    { raw: "Competitive" },
  );
  assertEquals(parseAshbyCompensation({}), undefined);
  assertEquals(parseAshbyCompensation(null), undefined);
});

Deno.test("ashby: an unrecognized interval is left unset, not guessed", () => {
  const comp = parseAshbyCompensation({
    summaryComponents: [
      { compensationType: "Salary", interval: "2 WEEK", minValue: 1000, maxValue: 2000 },
    ],
  });
  assertEquals(comp, { minAmount: 1000, maxAmount: 2000 });
});

Deno.test("ashby: unlisted postings are dropped, not recorded as live", () => {
  const withUnlisted = {
    jobs: fixture.jobs.map((job, index) => (index === 1 ? { ...job, isListed: false } : job)),
  };
  const postings = parseAshbyBoard(withUnlisted, SOURCE_URL);
  assertEquals(postings.length, 2);
  assert(postings.every((p) => p.externalId !== fixture.jobs[1]!.id));
});

Deno.test("ashby: a malformed payload fails the parse", () => {
  assertThrows(() => parseAshbyBoard(null, SOURCE_URL), FetchFailure);
  assertThrows(() => parseAshbyBoard({ postings: [] }, SOURCE_URL), FetchFailure);
});

Deno.test("ashby: a posting missing a required field fails the whole board", () => {
  const broken = { jobs: [{ ...fixture.jobs[0], title: "  " }] };
  const error = assertThrows(() => parseAshbyBoard(broken, SOURCE_URL), FetchFailure);
  assert(error.kind === "parse");
});
