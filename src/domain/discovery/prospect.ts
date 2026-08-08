/**
 * Draining the prospect queue (§12).
 *
 * The gap M9 left is not slug guessing — that works. It is that you have to
 * already know a company's name to type it, and the companies on these three
 * platforms are mostly ones you have never heard of. So the useful unit of work
 * stopped being "look up Stripe" and became "here are three hundred names off a
 * portfolio page, tell me which of them have boards".
 *
 * Three hundred names is roughly twelve hundred requests per host at one per
 * second: about twenty minutes. That is not a page load, and M9 declined bulk
 * paste for exactly that reason. It is, however, precisely the shape of work
 * the job routes already do — so this is `embedPending`'s contract, not
 * `resolveBoards`': claim a bounded slice, do it properly, report what is left,
 * and let the schedule call again.
 *
 * Pure orchestration over ports, like `collect.ts`. It knows nothing about
 * Postgres or HTTP, and the governing rule is the same one collection has:
 * **one failing prospect must never abort a drain.**
 */

import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import type { Platform } from "@platform/ids.ts";
import type { BoardSource } from "./types.ts";
import { type BoardCandidateRepo, type BoardProbe, resolveBoards } from "./resolve.ts";

/** A name someone wants asked about, and where they got it. */
export interface NewProspect {
  readonly query: string;
  /** Free text: which harvest this came from, so a dry source is visible. */
  readonly source?: string;
}

export interface Prospect {
  readonly query: string;
  readonly source?: string;
  readonly enqueuedAt: Date;
  readonly resolvedAt?: Date;
  readonly attempts: number;
  /** Boards found. Zero is an answer; absent means still pending. */
  readonly hits?: number;
  readonly lastError?: string;
}

/** A prospect leased to this run. */
export interface ClaimedProspect {
  readonly query: string;
  readonly source?: string;
  /** Including this one, so a use case can tell a first try from a last. */
  readonly attempts: number;
}

/**
 * How a drain settled one prospect.
 *
 *  - `resolved` — the platforms answered. `hits` may be zero; "no board
 *    anywhere" is a finding, and re-asking it next run would be the waste this
 *    queue exists to avoid.
 *  - `deferred` — we could not find out. The row stays pending and the lease is
 *    released, so the next run picks it up. Cheap to retry: every clear answer
 *    from the failed attempt is already cached in the catalogue, so a retry
 *    only re-asks the pairs that actually failed.
 */
export type ProspectOutcome =
  | { readonly kind: "resolved"; readonly hits: number; readonly note?: string; readonly at: Date }
  | { readonly kind: "deferred"; readonly reason: string };

export interface ProspectCounts {
  readonly pending: number;
  readonly resolved: number;
  /** Pending, but out of attempts. Visible rather than silently dropped. */
  readonly stuck: number;
}

export interface ProspectQuery {
  readonly limit: number;
  /** Pending rows only — what the queue still owes an answer on. */
  readonly pendingOnly?: boolean;
}

export interface ProspectRepo {
  /** Returns how many rows were new. Re-enqueuing a known name is a no-op. */
  enqueue(entries: readonly NewProspect[]): Promise<number>;
  /**
   * Lease the next pending prospects, oldest first, incrementing attempts.
   * Rows already leased by a live run are skipped rather than waited on.
   */
  claim(
    limit: number,
    opts: { readonly now: Date; readonly leaseCutoff: Date; readonly maxAttempts: number },
  ): Promise<ClaimedProspect[]>;
  settle(query: string, outcome: ProspectOutcome): Promise<void>;
  /**
   * Give back rows this run claimed but never attempted, un-spending the
   * attempt the claim charged them. Without this a run that stops on its
   * deadline leaves its unasked rows leased *and* one attempt poorer, and three
   * such runs would retire a name to `stuck` having never asked about it once.
   */
  release(queries: readonly string[]): Promise<void>;
  counts(maxAttempts: number): Promise<ProspectCounts>;
  list(query: ProspectQuery): Promise<Prospect[]>;
  /** Forget resolved rows. The catalogue keeps the answers; this is just queue. */
  clearResolved(): Promise<number>;
}

/* ------------------------------------------------------------ policy ------ */

/**
 * Prospects per run. One prospect is at most four slugs against each platform,
 * and platforms run concurrently, so it costs about four seconds of wall clock
 * — a full slice is a couple of minutes. Small enough to be a comfortable HTTP
 * request, large enough that a scheduled quarter-hour drain clears a few
 * hundred names a day.
 */
export const DEFAULT_PROSPECT_LIMIT = 25;

/**
 * Wall-clock budget for a run. The prospect count alone is not a safe bound: a
 * struggling upstream turns every probe into a retry with backoff, and a slice
 * sized for two minutes can then take twenty. Whichever bound is reached first
 * ends the run, and the report says which.
 */
export const DEFAULT_PROSPECT_DEADLINE_MS = 3 * 60 * 1000;

/**
 * The budget for a drain someone is watching, as opposed to one a schedule
 * runs. Small on purpose: a prospect costs about four seconds, so five is
 * roughly twenty — a slow page load rather than an abandoned one. The page says
 * how many are left and offers to go again, which is the same bargain
 * `/matches/refresh` strikes with the embedding backlog.
 *
 * This exists so the queue is usable without a scheduler at all. Filling a
 * queue you cannot drain is friction, and friction here is a bug.
 */
export const INTERACTIVE_PROSPECT_LIMIT = 5;
export const INTERACTIVE_PROSPECT_DEADLINE_MS = 20 * 1000;

/**
 * Attempts before a prospect stops being retried. Failures here are "we could
 * not find out", which is usually transient — but a name that has failed three
 * times is telling us something the fourth attempt will not, and a queue that
 * retries forever is one that never drains.
 */
export const MAX_PROSPECT_ATTEMPTS = 3;

/**
 * How long a claim is honoured before another run may take the row. Comfortably
 * longer than a run's own deadline, so a slow-but-alive run is never overtaken
 * by the next one.
 */
export const PROSPECT_LEASE_MS = 15 * 60 * 1000;

/* ----------------------------------------------------------- use case ----- */

export interface ResolveProspectsDeps {
  readonly prospects: ProspectRepo;
  readonly candidates: BoardCandidateRepo;
  readonly probe: BoardProbe;
  readonly sourceFor: (platform: Platform) => BoardSource | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ResolveProspectsOptions {
  readonly limit?: number;
  readonly deadlineMs?: number;
}

/** A board found by the drain — the payload worth sending on to a digest. */
export interface ProspectHit {
  readonly query: string;
  readonly platform: Platform;
  readonly slug: string;
  readonly companyName?: string;
  readonly postingCount?: number;
  readonly source?: string;
}

export interface ProspectReport {
  readonly claimed: number;
  readonly resolved: number;
  readonly deferred: number;
  readonly hits: readonly ProspectHit[];
  /** Names that resolved to no board anywhere. Worth seeing; not a failure. */
  readonly empty: readonly string[];
  readonly failures: readonly { readonly query: string; readonly reason: string }[];
  /** True when the run stopped on its deadline rather than finishing the slice. */
  readonly stoppedEarly: boolean;
  readonly counts: ProspectCounts;
}

/**
 * Drain a bounded slice of the queue.
 *
 * Prospects are processed **one at a time, deliberately**. Running them
 * concurrently would not go faster — the polite fetcher serializes per host, so
 * every prospect is queueing behind the same three hosts either way — and it
 * would make the deadline meaningless, because a run could not stop without
 * abandoning work already in flight. Sequential means the deadline lands
 * cleanly on a prospect boundary and every claimed row is either settled or
 * still leased, never half-asked.
 */
export async function resolveProspects(
  deps: ResolveProspectsDeps,
  options: ResolveProspectsOptions = {},
): Promise<ProspectReport> {
  const limit = options.limit ?? DEFAULT_PROSPECT_LIMIT;
  const deadlineMs = options.deadlineMs ?? DEFAULT_PROSPECT_DEADLINE_MS;
  const startedAt = deps.clock.now();
  const deadline = startedAt.getTime() + deadlineMs;

  const claimed = await deps.prospects.claim(limit, {
    now: startedAt,
    leaseCutoff: new Date(startedAt.getTime() - PROSPECT_LEASE_MS),
    maxAttempts: MAX_PROSPECT_ATTEMPTS,
  });

  const hits: ProspectHit[] = [];
  const empty: string[] = [];
  const failures: { query: string; reason: string }[] = [];
  let resolved = 0;
  let deferred = 0;
  let stoppedEarly = false;

  for (const [index, prospect] of claimed.entries()) {
    // Checked before starting a prospect, never during: a prospect is the
    // atomic unit of this run. Stopping halfway through one would leave the
    // lease held on a row we had already spent requests on.
    //
    // Everything still unasked goes back to the queue intact, so the next run
    // finds it exactly as this one did rather than a lease and an attempt worse
    // off.
    if (index > 0 && deps.clock.now().getTime() >= deadline) {
      stoppedEarly = true;
      await deps.prospects.release(claimed.slice(index).map((rest) => rest.query));
      break;
    }

    try {
      const report = await resolveBoards(prospect.query, {
        candidates: deps.candidates,
        probe: deps.probe,
        sourceFor: deps.sourceFor,
        clock: deps.clock,
        logger: deps.logger,
      });

      // Nothing sluggable in the text. Not a failure to find out — there was
      // never a question to ask — so retrying it would fail identically
      // forever. Resolved, with the reason kept on the row.
      if (report.tried.length === 0) {
        await deps.prospects.settle(prospect.query, {
          kind: "resolved",
          hits: 0,
          note: "No letters or digits to build a slug from.",
          at: deps.clock.now(),
        });
        resolved++;
        empty.push(prospect.query);
        continue;
      }

      const found = report.results.filter((result) => result.found);
      const errored = report.results.filter((result) => result.error !== undefined);

      // A board found is an answer, whatever else went wrong alongside it. Only
      // when nothing was found does an error mean the question is still open —
      // "no board here" and "we could not ask" must not collapse into each
      // other, at the queue exactly as in the catalogue.
      if (found.length === 0 && errored.length > 0) {
        const reason = errored[0]?.error ?? "unknown";
        await deps.prospects.settle(prospect.query, { kind: "deferred", reason });
        deferred++;
        failures.push({ query: prospect.query, reason });
        continue;
      }

      await deps.prospects.settle(prospect.query, {
        kind: "resolved",
        hits: found.length,
        at: deps.clock.now(),
      });
      resolved++;

      if (found.length === 0) empty.push(prospect.query);
      for (const candidate of found) {
        hits.push({
          query: prospect.query,
          platform: candidate.platform,
          slug: candidate.slug,
          ...(candidate.companyName !== undefined ? { companyName: candidate.companyName } : {}),
          ...(candidate.postingCount !== undefined ? { postingCount: candidate.postingCount } : {}),
          ...(prospect.source !== undefined ? { source: prospect.source } : {}),
        });
      }
    } catch (error) {
      // One prospect must never abort the drain (§12). The row is left pending
      // with its reason, and the names behind it in the queue still get asked.
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.warn("prospect failed", { query: prospect.query, error: reason });
      await deps.prospects.settle(prospect.query, { kind: "deferred", reason });
      deferred++;
      failures.push({ query: prospect.query, reason });
    }
  }

  const counts = await deps.prospects.counts(MAX_PROSPECT_ATTEMPTS);

  deps.logger.info("prospect drain", {
    claimed: claimed.length,
    resolved,
    deferred,
    boardsFound: hits.length,
    stoppedEarly,
    pending: counts.pending,
    stuck: counts.stuck,
  });

  return {
    claimed: claimed.length,
    resolved,
    deferred,
    hits,
    empty,
    failures,
    stoppedEarly,
    counts,
  };
}

/**
 * What a drain did, in a sentence, for the page that ran it.
 *
 * Pure, and here rather than in the handler, because the branching is where
 * this gets quietly wrong: "found no boards" and "could not reach anyone" are
 * different outcomes and must not read the same, and a remaining backlog has to
 * say so or the button looks broken when it was merely bounded.
 */
export function describeDrain(report: ProspectReport): string {
  if (report.claimed === 0) return "Nothing in the queue to ask about.";

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts = [
    `Asked about ${plural(report.resolved + report.deferred, "name")}`,
    report.hits.length > 0 ? `found ${plural(report.hits.length, "board")}` : "found no boards",
  ];
  // Named separately from the misses: "we could not reach the platform" and
  // "there is no board there" are different answers, and the queue keeps them
  // apart everywhere else too.
  if (report.deferred > 0) {
    parts.push(`${plural(report.deferred, "name")} could not be reached and stayed queued`);
  }
  if (report.counts.pending > 0) {
    parts.push(`${report.counts.pending} still queued — ask again to continue`);
  }
  return parts.join(" · ");
}

/* ------------------------------------------------------------ parsing ----- */

/** Names per paste. Generous — a portfolio page is a few hundred — but bounded. */
export const MAX_PASTED_PROSPECTS = 500;

/**
 * One name per line, from a pasted list.
 *
 * Trailing commas and surrounding quotes are stripped because the realistic
 * source is a column copied out of a spreadsheet or a portfolio page, and
 * making the user clean that up by hand is the friction this whole feature
 * exists to remove. Blank lines and `#` comments are dropped so an annotated
 * list pastes as-is.
 *
 * Deduplication is case-insensitive and order-preserving: "Stripe" and "stripe"
 * generate identical slugs, so they are one question.
 */
export function parseProspectList(input: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const line of input.split("\n")) {
    const cleaned = line
      .trim()
      .replace(/,+$/, "")
      .replace(/^["'](.*)["']$/, "$1")
      .trim();
    if (cleaned === "" || cleaned.startsWith("#")) continue;
    if (cleaned.length > 200) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(cleaned);
    if (names.length === MAX_PASTED_PROSPECTS) break;
  }

  return names;
}
