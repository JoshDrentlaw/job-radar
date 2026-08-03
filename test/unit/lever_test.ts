/**
 * Lever parser tests. The fixture is live data from Spotify's board (August
 * 2026), trimmed at tag boundaries — real shapes, not invented ones.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { leverBoardUrl, parseLeverBoard } from "@adapters/ats/lever.ts";
import { FetchFailure } from "@adapters/ats/http.ts";
import fixture from "../fixtures/lever-board.json" with { type: "json" };

const SOURCE_URL = leverBoardUrl("spotify");

Deno.test("lever: url encodes the slug", () => {
  assertEquals(
    leverBoardUrl("a b"),
    "https://api.lever.co/v0/postings/a%20b?mode=json",
  );
});

Deno.test("lever: parses live fixture postings", () => {
  const postings = parseLeverBoard(fixture, SOURCE_URL);
  assertEquals(postings.length, 2);

  const [first, second] = postings;
  assertEquals(first!.externalId, "890b2c0f-f46f-4a4b-bb73-3a6af6e0edd5");
  assertEquals(first!.title, "Advertiser Solutions Vendor Lead - Programmatic and Direct Support");
  assertEquals(
    first!.applyUrl,
    "https://jobs.lever.co/spotify/890b2c0f-f46f-4a4b-bb73-3a6af6e0edd5",
  );
  assertEquals(first!.workplaceRaw, "hybrid");
  assertEquals(first!.employmentType, "Permanent");
  assertEquals(first!.department, "Advertising");
  assertEquals(first!.locationRaw, "London");
  assertEquals(first!.postedAt, new Date(1784569799619));
  assertEquals(first!.compensation, undefined);

  // categories.commitment was genuinely absent on this posting — stays unset.
  assertEquals(second!.employmentType, undefined);
  assertEquals(second!.workplaceRaw, "remote");
  // location plus allLocations, deduplicated.
  assertEquals(second!.locationRaw, "London | Stockholm");
});

Deno.test("lever: reassembles description from intro, lists and additional", () => {
  const postings = parseLeverBoard(fixture, SOURCE_URL);
  const first = postings[0]!;

  assertStringIncludes(first.descriptionText, "Sell what you love.");
  assertStringIncludes(first.descriptionText, "### What You'll Do");
  assertStringIncludes(first.descriptionText, "- Serve as the programmatic product expert");
  assertStringIncludes(first.descriptionText, "Spotify is an equal opportunity employer.");
});

Deno.test("lever: list items survive the div wrapper observed live", () => {
  // The second posting's list content arrives as `<div>\n<li>…</li></div>`.
  // A converter that only reads direct <li> children of <ul> drops every one
  // of these items silently.
  const second = parseLeverBoard(fixture, SOURCE_URL)[1]!;
  assertStringIncludes(second.descriptionText, "### Who You Are");
  assertStringIncludes(
    second.descriptionText,
    "- You have 10+ years of experience leading creative work",
  );
});

Deno.test("lever: an empty board is a valid answer, not an error", () => {
  assertEquals(parseLeverBoard([], SOURCE_URL), []);
});

Deno.test("lever: a non-array payload fails the parse", () => {
  assertThrows(() => parseLeverBoard({ jobs: [] }, SOURCE_URL), FetchFailure);
  assertThrows(() => parseLeverBoard(null, SOURCE_URL), FetchFailure);
});

Deno.test("lever: a posting missing a required field fails the whole board", () => {
  const broken = [{ ...(fixture[0] as object), id: "" }];
  const error = assertThrows(() => parseLeverBoard(broken, SOURCE_URL), FetchFailure);
  assert(error.kind === "parse");
});
