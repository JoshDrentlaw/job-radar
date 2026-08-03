/**
 * What the dashboard says is waiting.
 *
 * The rules are small but they are rules: a proposal nobody has read outranks
 * an application nobody has sent, "going quiet" is a warning before the window
 * closes rather than after, and a panel with nothing in it says nothing.
 */

import { assert, assertEquals } from "@std/assert";
import { whatIsWaiting } from "@web/routes/dashboard.tsx";
import type { ApplicationStatus, ApplicationSummary } from "@domain/pipeline/types.ts";
import type { PendingRun } from "@domain/dossier/proposals.ts";
import { asApplicationId, asPostingId, type VariantId } from "@platform/ids.ts";

const NOW = new Date("2026-08-03T00:00:00Z");
const DAY = 86_400_000;
const APP_ID = "50d3fc8f-f23e-403e-a633-5aeef8bfaeb6";

function run(pending: number, flagged: number): PendingRun {
  return {
    runId: "run-1",
    variantId: "variant-1" as VariantId,
    variantName: "Platform",
    postingTitle: "Staff SRE",
    pending,
    flagged,
    createdAt: NOW,
  };
}

function application(daysQuiet: number): ApplicationSummary {
  return {
    id: asApplicationId(APP_ID),
    postingId: asPostingId("greenhouse:acme:1"),
    postingTitle: "Staff SRE",
    companyName: "Acme",
    status: "sent",
    lastActivityAt: new Date(NOW.getTime() - daysQuiet * DAY),
    eventCount: 1,
  };
}

function waiting(overrides: Partial<Parameters<typeof whatIsWaiting>[0]> = {}) {
  return whatIsWaiting({
    pendingRuns: [],
    applications: new Map<ApplicationStatus, number>(),
    awaiting: [],
    failingBoards: 0,
    now: NOW,
    ghostAfterDays: 21,
    ...overrides,
  });
}

Deno.test("nothing waiting says nothing", () => {
  assertEquals(waiting(), []);
});

Deno.test("unread proposals come first — a model wrote them and nobody has looked", () => {
  const items = waiting({
    pendingRuns: [run(4, 0)],
    applications: new Map<ApplicationStatus, number>([["drafting", 2]]),
    failingBoards: 1,
  });
  assert(items[0]?.what.includes("proposed rewrite"), items[0]?.what);
  assert(items[0]?.href.startsWith("/dossier/runs/"));
});

Deno.test("a drift flag is what makes a review urgent", () => {
  assertEquals(waiting({ pendingRuns: [run(4, 0)] })[0]?.urgent, false);
  const flagged = waiting({ pendingRuns: [run(4, 2)] })[0]!;
  assertEquals(flagged.urgent, true);
  assert(flagged.detail.includes("2 flagged"));
  // The guarantee is restated wherever proposals are mentioned.
  assert(flagged.detail.includes("until you accept it"));
});

Deno.test("counts are summed across runs and read as English", () => {
  const items = waiting({ pendingRuns: [run(1, 0)] });
  assert(items[0]!.what.startsWith("1 proposed rewrite awaiting"), items[0]!.what);
  const many = waiting({ pendingRuns: [run(2, 0), run(3, 0)] });
  assert(many[0]!.what.startsWith("5 proposed rewrites awaiting"), many[0]!.what);
});

Deno.test("going quiet warns before the window closes, not after", () => {
  const notYet = waiting({ awaiting: [application(10)], ghostAfterDays: 21 });
  assertEquals(notYet.length, 0, "ten days of silence out of twenty-one is not news");

  const soon = waiting({ awaiting: [application(17)], ghostAfterDays: 21 });
  assertEquals(soon.length, 1);
  assert(soon[0]!.what.includes("going quiet"));
  // The honest framing travels with the warning.
  assert(soon[0]!.detail.includes("says nothing about the employer"));

  const past = waiting({ awaiting: [application(30)], ghostAfterDays: 21 });
  assertEquals(past.length, 0, "past the window it is the sweep's business, not a warning");
});

Deno.test("the window is the configured one, not a constant", () => {
  // Seven days of silence is nothing on a 21-day window and nearly everything
  // on a 7-day one.
  assertEquals(waiting({ awaiting: [application(6)], ghostAfterDays: 21 }).length, 0);
  assertEquals(waiting({ awaiting: [application(6)], ghostAfterDays: 7 }).length, 1);
  assert(waiting({ awaiting: [application(6)], ghostAfterDays: 7 })[0]!.detail.includes("7-day"));
});

Deno.test("an unreadable board is urgent, because every count on the site is wrong", () => {
  const items = waiting({ failingBoards: 2 });
  assertEquals(items.length, 1);
  assertEquals(items[0]!.urgent, true);
  assertEquals(items[0]!.href, "/coverage");
  assert(items[0]!.what.startsWith("2 boards"));
});

Deno.test("drafting and ghosted are surfaced, and neither implies anything was sent for you", () => {
  const items = waiting({
    applications: new Map<ApplicationStatus, number>([["drafting", 1], ["ghosted", 3]]),
  });
  assertEquals(items.length, 2);
  assert(items[0]!.what.includes("still drafting"));
  assert(
    items[0]!.detail.includes("never submits") || items[0]!.detail.includes("submits anything"),
  );
  assert(items[1]!.what.includes("3 applications marked ghosted"));
});

Deno.test("statuses with a zero count are not mentioned", () => {
  const items = waiting({
    applications: new Map<ApplicationStatus, number>([["drafting", 0], ["ghosted", 0], [
      "sent",
      9,
    ]]),
  });
  assertEquals(items, []);
});
