/**
 * The existence probe.
 *
 * The URLs asserted here are the cheap ones, measured against the live
 * endpoints before the prober was written — 28 bytes for Greenhouse, ~10 KB for
 * a limited Lever feed. If someone "tidies" one of these back to the full board
 * URL, speculative probing quietly becomes a megabyte per guess, so the shape
 * of the URL is part of the contract and is tested as such.
 *
 * The distinction that matters most here is 404 versus everything else. A 404
 * is the platform answering "no board". A timeout is not an answer, and
 * recording it as one would put a wrong fact in the catalogue for a week.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { AtsProber, probeUrl } from "@adapters/ats/probe.ts";
import { PoliteFetcher } from "@adapters/ats/http.ts";

/** No politeness delay and no retries: these tests are about outcomes. */
function proberFor(handler: (url: string) => Response): { prober: AtsProber; urls: string[] } {
  const urls: string[] = [];
  const http = new PoliteFetcher({
    userAgent: "job-radar/test",
    minIntervalMs: 0,
    maxRetries: 0,
    baseBackoffMs: 0,
    sleep: () => Promise.resolve(),
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : String(input);
      urls.push(url);
      return Promise.resolve(handler(url));
    },
  });
  return { prober: new AtsProber(http), urls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("probe: each platform is asked in its cheapest form", () => {
  assertEquals(probeUrl("greenhouse", "esri"), "https://boards-api.greenhouse.io/v1/boards/esri");
  // limit=1 rather than the whole board: ~10 KB against ~1 MB.
  assertStringIncludes(probeUrl("lever", "spotify") ?? "", "limit=1");
  assertEquals(
    probeUrl("ashby", "linear"),
    "https://api.ashbyhq.com/posting-api/job-board/linear",
  );
});

Deno.test("probe: a platform with no adapter is not asked at all", () => {
  assertEquals(probeUrl("workable", "acme"), null);
});

Deno.test("probe: slugs are encoded into the URL", () => {
  assertStringIncludes(probeUrl("greenhouse", "a b") ?? "", "a%20b");
});

Deno.test("probe: greenhouse states the company's own name on a hit", async () => {
  const { prober } = proberFor(() => json({ name: "Esri", content: "" }));
  assertEquals(await prober.probe("greenhouse", "esri"), { found: true, companyName: "Esri" });
});

Deno.test("probe: a hit with no name is still a hit", async () => {
  const { prober } = proberFor(() => json({ jobs: [] }));
  assertEquals(await prober.probe("ashby", "linear"), { found: true });
  // Greenhouse with a blank name must not invent one.
  const blank = proberFor(() => json({ name: "   ", content: "" }));
  assertEquals(await blank.prober.probe("greenhouse", "x"), { found: true });
});

Deno.test("probe: a 404 is a clean 'no board here'", async () => {
  const { prober } = proberFor(() => json({ error: "not found" }, 404));
  const result = await prober.probe("greenhouse", "definitelynotacompany");
  assertEquals(result, { found: false });
  assertEquals(result.error, undefined, "a 404 is an answer, not a failure");
});

Deno.test("probe: anything that is not a 404 is a failure to find out", async () => {
  for (const status of [500, 503, 403]) {
    const { prober } = proberFor(() => json({}, status));
    const result = await prober.probe("lever", "spotify");
    assertEquals(result.found, false, `${status} must not read as a board`);
    assertEquals(
      result.error !== undefined,
      true,
      `${status} must be reported as a failure, not a clean miss`,
    );
  }
});

Deno.test("probe: a network error is a failure to find out, not a miss", async () => {
  const http = new PoliteFetcher({
    userAgent: "job-radar/test",
    minIntervalMs: 0,
    maxRetries: 0,
    sleep: () => Promise.resolve(),
    fetchImpl: () => Promise.reject(new Error("connection reset")),
  });
  const result = await new AtsProber(http).probe("ashby", "linear");
  assertEquals(result.found, false);
  assertStringIncludes(result.error ?? "", "connection reset");
});

Deno.test("probe: a body that is not JSON is a failure, not a hit", async () => {
  const { prober } = proberFor(() => new Response("<html>maintenance</html>", { status: 200 }));
  const result = await prober.probe("greenhouse", "esri");
  assertEquals(result.found, false);
  assertEquals(result.error !== undefined, true);
});

Deno.test("probe: one request per question", async () => {
  const { prober, urls } = proberFor(() => json({ name: "Esri" }));
  await prober.probe("greenhouse", "esri");
  assertEquals(urls, ["https://boards-api.greenhouse.io/v1/boards/esri"]);
});
