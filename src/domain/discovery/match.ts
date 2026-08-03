/**
 * Scoring (§7).
 *
 * A match is the best chunk pair between a posting and a facet. Only stale
 * pairs are scored — new or changed on either side — so the run cost tracks
 * what actually changed, not corpus size. After scoring, per-chunk best scores
 * are refreshed for the affected postings; the low end of those is what the
 * UI presents as gaps.
 */

import type { PostingId } from "@platform/ids.ts";
import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import type { MatchRepo } from "./matching.ts";

export interface MatchDeps {
  readonly matches: MatchRepo;
  readonly model: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface MatchReport {
  readonly pairsConsidered: number;
  readonly pairsScored: number;
  /** Pairs skipped because one side had no fresh vectors yet. */
  readonly pairsUnready: number;
  readonly postingsTouched: number;
}

export async function scorePending(deps: MatchDeps): Promise<MatchReport> {
  const { matches, model, logger } = deps;

  const pairs = await matches.stalePairs(model);
  const touched = new Set<PostingId>();
  let scored = 0;
  let unready = 0;

  for (const pair of pairs) {
    const score = await matches.scorePair(pair, model, deps.clock.now());
    if (score === null) {
      unready += 1;
      continue;
    }
    scored += 1;
    touched.add(pair.postingId);
  }

  if (touched.size > 0) {
    await matches.refreshBestScores([...touched], model, deps.clock.now());
  }

  const report: MatchReport = {
    pairsConsidered: pairs.length,
    pairsScored: scored,
    pairsUnready: unready,
    postingsTouched: touched.size,
  };
  logger.info("match scoring finished", { ...report, model });
  return report;
}
