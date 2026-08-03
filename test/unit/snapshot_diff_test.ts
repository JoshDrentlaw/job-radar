/**
 * Snapshot diff tests (§6). The diff is computed entirely from our own content
 * hashes; these tests are the contract that appeared/changed/disappeared mean
 * exactly what the coverage ledger says they mean.
 */

import { assertEquals } from "@std/assert";
import { diffSnapshots } from "@domain/discovery/snapshot-diff.ts";

const entry = (externalId: string, contentHash: string) => ({ externalId, contentHash });

Deno.test("diff: no prior snapshot means everything appeared", () => {
  const diff = diffSnapshots(null, [entry("a", "1"), entry("b", "2")]);
  assertEquals(diff, { appeared: ["a", "b"], changed: [], disappeared: [], unchanged: [] });
});

Deno.test("diff: hash changes are changed, absences are disappeared", () => {
  const previous = [entry("a", "1"), entry("b", "2"), entry("c", "3")];
  const current = [entry("a", "1"), entry("b", "2-changed"), entry("d", "4")];
  const diff = diffSnapshots(previous, current);
  assertEquals(diff.appeared, ["d"]);
  assertEquals(diff.changed, ["b"]);
  assertEquals(diff.disappeared, ["c"]);
  assertEquals(diff.unchanged, ["a"]);
});

Deno.test("diff: an empty current board disappears everything", () => {
  const diff = diffSnapshots([entry("a", "1")], []);
  assertEquals(diff, { appeared: [], changed: [], disappeared: ["a"], unchanged: [] });
});

Deno.test("diff: identical snapshots produce an empty diff", () => {
  const entries = [entry("a", "1"), entry("b", "2")];
  const diff = diffSnapshots(entries, entries);
  assertEquals(diff, { appeared: [], changed: [], disappeared: [], unchanged: ["a", "b"] });
});
