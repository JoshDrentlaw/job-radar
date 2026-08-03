/**
 * Location derivation tests. The deriveRemoteHint contract: a source-asserted
 * workplace label wins, the location string is inferred from only when the
 * source said nothing, and `unknown` is the honest default.
 */

import { assertEquals } from "@std/assert";
import { deriveRemoteHint, normalizeLocation } from "@domain/discovery/location.ts";

Deno.test("remote hint: a source-asserted label wins over the location string", () => {
  // Lever's lowercase vocabulary.
  assertEquals(deriveRemoteHint("London", "hybrid"), "hybrid");
  assertEquals(deriveRemoteHint("London", "remote"), "remote");
  assertEquals(deriveRemoteHint("London", "onsite"), "onsite");
  // Ashby's cased vocabulary.
  assertEquals(deriveRemoteHint("Tokyo, Japan", "Remote"), "remote");
  assertEquals(deriveRemoteHint("New York, NY (HQ)", "OnSite"), "onsite");
  // The assertion beats a contradictory location string.
  assertEquals(deriveRemoteHint("Remote - US", "OnSite"), "onsite");
});

Deno.test("remote hint: an unrecognized assertion falls through to the string rules", () => {
  assertEquals(deriveRemoteHint("San Francisco", "remote-first culture!"), "unknown");
  assertEquals(deriveRemoteHint("Hybrid - London", "flexible"), "hybrid");
});

Deno.test("remote hint: location-string inference is unchanged when nothing is asserted", () => {
  assertEquals(deriveRemoteHint("Hybrid - San Francisco, New York City"), "hybrid");
  assertEquals(deriveRemoteHint("Remote"), "remote");
  assertEquals(deriveRemoteHint("On-site, Austin"), "onsite");
  // A bare city says nothing about attendance.
  assertEquals(deriveRemoteHint("San Francisco, CA"), "unknown");
  // "Remote-Friendly" co-listed with named offices is genuinely ambiguous.
  assertEquals(
    deriveRemoteHint("Remote-Friendly (Travel-Required) | San Francisco, CA | Washington, DC"),
    "unknown",
  );
  assertEquals(deriveRemoteHint(""), "unknown");
});

Deno.test("normalize: strips modality prefixes, unifies separators, deduplicates", () => {
  assertEquals(
    normalizeLocation("Hybrid - San Francisco, New York City"),
    "San Francisco, New York City",
  );
  assertEquals(
    normalizeLocation("San Francisco, CA • New York, NY • United States"),
    "San Francisco, CA | New York, NY | United States",
  );
  assertEquals(normalizeLocation("London | London"), "London");
  assertEquals(normalizeLocation(""), null);
});
