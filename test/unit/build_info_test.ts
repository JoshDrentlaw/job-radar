/**
 * `readDeployedCommit` takes an injectable reader for the same reason
 * `loadConfig` takes an injectable `EnvSource` (config_test.ts): the real one
 * hits the filesystem, and a fake makes every path — present, blank, missing —
 * cheap to exercise without a COMMIT file on disk.
 */

import { assertEquals } from "@std/assert";
import { readDeployedCommit } from "@platform/build-info.ts";

Deno.test("reads and shortens the commit the deploy script wrote", async () => {
  const sha = await readDeployedCommit("COMMIT", () => Promise.resolve("abcdef1234567890\n"));
  assertEquals(sha, "abcdef12");
});

Deno.test("blank file reads as no commit, not an eight-character blank", async () => {
  const sha = await readDeployedCommit("COMMIT", () => Promise.resolve("   \n"));
  assertEquals(sha, undefined);
});

Deno.test("a missing file — every development machine — reads as no commit", async () => {
  const sha = await readDeployedCommit(
    "COMMIT",
    () => Promise.reject(new Deno.errors.NotFound("no such file")),
  );
  assertEquals(sha, undefined);
});
