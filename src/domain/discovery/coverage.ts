/**
 * Coverage ledger (§10).
 *
 * Any match count shown to the user must be able to answer "what did this not
 * see?" without being asked. A count with no denominator is a misleading
 * artifact, so every collection run records its denominator and its failures,
 * and the blind spots below are stated permanently rather than discovered.
 */

import type { BoardId } from "@platform/ids.ts";

export interface BoardOutcome {
  readonly boardId: BoardId;
  readonly companyName: string;
  readonly status: "ok" | "failed";
  readonly reason?: string;
  readonly postingsSeen: number;
  readonly appeared: number;
  readonly changed: number;
  readonly disappeared: number;
}

export interface CollectionRun {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly trigger: "manual" | "scheduled";
  readonly boardsConfigured: number;
  readonly boardsFetched: number;
  readonly boardsFailed: number;
  readonly postingsSeen: number;
  readonly postingsNew: number;
  readonly postingsChanged: number;
  readonly postingsDisappeared: number;
}

export interface CollectionReport extends CollectionRun {
  readonly boards: readonly BoardOutcome[];
}

export interface CollectionRunRepo {
  start(run: Omit<CollectionRun, "finishedAt">): Promise<void>;
  finish(run: CollectionRun): Promise<void>;
  recent(limit: number): Promise<CollectionRun[]>;
  get(id: string): Promise<CollectionRun | null>;
}

/**
 * Declared blind spots. Permanently visible in the UI, not a backlog (§2, §10).
 *
 * These are not "not yet implemented". LinkedIn and Indeed are closed and
 * hostile, and reaching them would require the headless browsers and CAPTCHA
 * solving that §2 rules out by definition. The rest are structural: no public
 * feed means no adapter, however much one might want the coverage.
 */
export interface BlindSpot {
  readonly name: string;
  readonly reason: string;
}

export const DECLARED_BLIND_SPOTS: readonly BlindSpot[] = [
  {
    name: "LinkedIn",
    reason:
      "Closed and hostile to automated access. Reaching it would need a headless browser and " +
      "CAPTCHA solving, which are out of scope by definition — not a backlog item.",
  },
  {
    name: "Indeed",
    reason: "Same as LinkedIn: no public syndication feed, active anti-automation.",
  },
  {
    name: "ZipRecruiter",
    reason: "No public no-auth feed intended for syndication.",
  },
  {
    name: "Workday-hosted boards",
    reason:
      "Each tenant hosts its own endpoint with no common public contract. Outside the adapter set.",
  },
  {
    name: "Companies whose ATS has no public feed",
    reason:
      "If a board cannot be read without authentication or a browser, it is not collected at all.",
  },
  {
    name: "Every company not in the board registry",
    reason:
      "This app only sees boards that were deliberately added. The registry is the denominator " +
      "for every count in this application.",
  },
] as const;
