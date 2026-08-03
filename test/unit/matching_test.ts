import { assertEquals, assertThrows } from "@std/assert";
import {
  bucketOf,
  DEFAULT_BUCKET_THRESHOLDS,
  loadBucketThresholds,
  type SettingsRepo,
  ThresholdError,
  validateThresholds,
} from "@domain/discovery/matching.ts";

const T = { strong: 0.6, plausible: 0.5 };

Deno.test("bucketOf: boundaries are inclusive at the top of each bucket", () => {
  assertEquals(bucketOf(0.75, T), "strong");
  assertEquals(bucketOf(0.6, T), "strong");
  assertEquals(bucketOf(0.599, T), "plausible");
  assertEquals(bucketOf(0.5, T), "plausible");
  assertEquals(bucketOf(0.499, T), "weak");
  assertEquals(bucketOf(-0.2, T), "weak");
});

Deno.test("validateThresholds: rejects inverted and out-of-range values", () => {
  assertThrows(() => validateThresholds(0.5, 0.6), ThresholdError);
  assertThrows(() => validateThresholds(1.5, 0.5), ThresholdError);
  assertThrows(() => validateThresholds(NaN, 0.5), ThresholdError);
  assertEquals(validateThresholds(0.6, 0.6), { strong: 0.6, plausible: 0.6 });
});

function settingsWith(value: unknown): SettingsRepo {
  return {
    get: <T>(_key: string) => Promise.resolve(value as T | null),
    set: () => Promise.resolve(),
  };
}

Deno.test("loadBucketThresholds: falls back to defaults when unset or corrupt", async () => {
  assertEquals(await loadBucketThresholds(settingsWith(null)), DEFAULT_BUCKET_THRESHOLDS);
  assertEquals(
    await loadBucketThresholds(settingsWith({ strong: "bad" })),
    DEFAULT_BUCKET_THRESHOLDS,
  );
  assertEquals(
    await loadBucketThresholds(settingsWith({ strong: 0.4, plausible: 0.7 })),
    DEFAULT_BUCKET_THRESHOLDS,
  );
  assertEquals(
    await loadBucketThresholds(settingsWith({ strong: 0.7, plausible: 0.55 })),
    { strong: 0.7, plausible: 0.55 },
  );
});
