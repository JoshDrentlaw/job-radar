/**
 * Greenhouse parser tests. The fixture is live data from Vercel's board
 * (August 2026), trimmed at (entity-encoded) tag boundaries.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { greenhouseBoardUrl, parseGreenhouseBoard } from "@adapters/ats/greenhouse.ts";
import { FetchFailure } from "@adapters/ats/http.ts";
import fixture from "../fixtures/greenhouse-board.json" with { type: "json" };

const SOURCE_URL = greenhouseBoardUrl("vercel");

Deno.test("greenhouse: parses live fixture postings", () => {
  const postings = parseGreenhouseBoard(fixture, SOURCE_URL);
  assertEquals(postings.length, 2);

  const first = postings[0]!;
  assertEquals(first.externalId, "5613601004");
  assertEquals(first.title, "Software Engineer, Growth");
  assertEquals(first.locationRaw, "Hybrid - San Francisco, New York City");
  assertEquals(first.department, "Engineering");
  assertEquals(first.applyUrl, "https://job-boards.greenhouse.io/vercel/jobs/5613601004");
  assertEquals(first.postedAt, new Date("2025-08-06T16:35:51-04:00"));
  // Greenhouse publishes neither of these; they must not be inferred.
  assertEquals(first.employmentType, undefined);
  assertEquals(first.compensation, undefined);
  assertEquals(first.workplaceRaw, undefined);
});

Deno.test("greenhouse: entity-encoded content is decoded and converted", () => {
  const first = parseGreenhouseBoard(fixture, SOURCE_URL)[0]!;
  assertStringIncludes(first.descriptionText, "## About Vercel:");
  assertStringIncludes(first.descriptionText, "agentic infrastructure company");
  assert(!first.descriptionText.includes("&lt;"), "entities must be decoded before parsing");
  assert(!first.descriptionText.includes("<p>"), "html must be converted, not passed through");
});

Deno.test("greenhouse: falls back to offices when location is missing", () => {
  const job = { ...(fixture.jobs[0] as Record<string, unknown>), location: null };
  const postings = parseGreenhouseBoard({ jobs: [job] }, SOURCE_URL);
  assertEquals(postings[0]!.locationRaw, "San Francisco, California, United States");
});

Deno.test("greenhouse: a malformed payload fails the parse", () => {
  assertThrows(() => parseGreenhouseBoard(null, SOURCE_URL), FetchFailure);
  assertThrows(() => parseGreenhouseBoard({ meta: {} }, SOURCE_URL), FetchFailure);
});

Deno.test("greenhouse: a posting missing a required field fails the whole board", () => {
  const broken = { jobs: [{ ...fixture.jobs[0], absolute_url: "" }] };
  const error = assertThrows(() => parseGreenhouseBoard(broken, SOURCE_URL), FetchFailure);
  assert(error.kind === "parse");
});
