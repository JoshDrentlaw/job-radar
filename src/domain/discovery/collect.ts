/**
 * The collection use-case: fetch active boards, diff against the last snapshot,
 * persist, and write a coverage record.
 *
 * This module is pure orchestration over ports (§4). It knows nothing about
 * Postgres, HTTP or Greenhouse — which is what makes it testable with in-memory
 * fakes and a fixed clock, and what will let M2's adapters slot in without
 * touching it.
 *
 * The governing rule (§12): **one failing board must never abort a run.** Every
 * per-board failure is caught, recorded with its reason, and the run continues.
 */

import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import { newSnapshotId, type Platform, postingId } from "@platform/ids.ts";
import { contentHash } from "./content-hash.ts";
import { diffSnapshots } from "./snapshot-diff.ts";
import { DERIVATION_VERSION, deriveRemoteHint, normalizeLocation } from "./location.ts";
import type {
  Board,
  BoardRegistry,
  BoardSource,
  Posting,
  PostingRepo,
  SnapshotEntry,
  SnapshotRepo,
  SourcePosting,
} from "./types.ts";
import type { BoardOutcome, CollectionReport, CollectionRunRepo } from "./coverage.ts";

export interface CollectDeps {
  readonly boards: BoardRegistry;
  readonly postings: PostingRepo;
  readonly snapshots: SnapshotRepo;
  readonly runs: CollectionRunRepo;
  /** Resolve a platform to its adapter, or null when none is registered yet. */
  readonly sourceFor: (platform: Platform) => BoardSource | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CollectOptions {
  readonly trigger?: "manual" | "scheduled";
  /** Restrict the run to specific boards; defaults to every active board. */
  readonly boardIds?: readonly string[];
  readonly runId?: string;
}

/** Build the persisted Posting from what the adapter asserted plus what we derived. */
function toPosting(
  board: Board,
  source: SourcePosting,
  hash: string,
  sourceUrl: string,
  adapterVersion: string,
  fetchedAt: Date,
  now: Date,
): Posting {
  return {
    ...source,
    id: postingId(board.id, source.externalId),
    boardId: board.id,
    firstSeenAt: now,
    lastSeenAt: now,
    currentlyListed: true,
    provenance: {
      platform: board.platform,
      adapterVersion,
      sourceUrl,
      fetchedAt,
      contentHash: hash,
    },
    derived: {
      locationNormalized: normalizeLocation(source.locationRaw),
      remoteHint: deriveRemoteHint(source.locationRaw, source.workplaceRaw),
      derivationVersion: DERIVATION_VERSION,
      derivedAt: now,
    },
  };
}

async function collectBoard(
  deps: CollectDeps,
  board: Board,
  runId: string,
): Promise<BoardOutcome> {
  const logger = deps.logger.with({ runId, boardId: board.id });
  const source = deps.sourceFor(board.platform);

  if (source === null) {
    const reason = `No adapter registered for platform "${board.platform}".`;
    logger.warn("board skipped", { reason });
    await deps.boards.recordFetchOutcome(board.id, {
      status: "failed",
      at: deps.clock.now(),
      error: reason,
    });
    return {
      boardId: board.id,
      companyName: board.companyName,
      status: "failed",
      reason,
      postingsSeen: 0,
      appeared: 0,
      changed: 0,
      disappeared: 0,
    };
  }

  const takenAt = deps.clock.now();
  let fetched;
  try {
    fetched = await source.fetchBoard(board.slug);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("board fetch failed", { error });
    await deps.boards.recordFetchOutcome(board.id, {
      status: "failed",
      at: deps.clock.now(),
      error: reason,
    });
    // The failed attempt is still recorded as a snapshot, so the ledger can
    // distinguish "we looked and it broke" from "we never looked".
    await deps.snapshots.save({
      id: newSnapshotId(),
      boardId: board.id,
      runId,
      takenAt,
      status: "failed",
      errorReason: reason,
      sourceUrl: "",
      adapterVersion: source.adapterVersion,
      postingCount: 0,
      entries: [],
    });
    return {
      boardId: board.id,
      companyName: board.companyName,
      status: "failed",
      reason,
      postingsSeen: 0,
      appeared: 0,
      changed: 0,
      disappeared: 0,
    };
  }

  const now = deps.clock.now();

  // Hash first: the diff is computed entirely from our own hashes, never from
  // the source's updated_at (§6).
  const hashed = await Promise.all(
    fetched.postings.map(async (posting) => ({
      posting,
      hash: await contentHash(posting),
    })),
  );

  const entries: SnapshotEntry[] = hashed.map(({ posting, hash }) => ({
    externalId: posting.externalId,
    contentHash: hash,
  }));

  const previous = await deps.snapshots.latestSuccessful(board.id);
  const diff = diffSnapshots(previous?.entries ?? null, entries);

  const changedIds = new Set([...diff.appeared, ...diff.changed]);
  const toWrite = hashed
    .filter(({ posting }) => changedIds.has(posting.externalId))
    .map(({ posting, hash }) =>
      toPosting(
        board,
        posting,
        hash,
        fetched.sourceUrl,
        source.adapterVersion,
        fetched.fetchedAt,
        now,
      )
    );

  if (toWrite.length > 0) await deps.postings.upsertMany(toWrite);
  if (diff.unchanged.length > 0) {
    await deps.postings.touchLastSeen(board.id, diff.unchanged, now);
  }
  // Anything present in this fetch is listed — including postings that had
  // previously disappeared and have come back.
  if (entries.length > 0) {
    await deps.postings.markListed(board.id, entries.map((e) => e.externalId), now);
  }
  // "No longer listed" and nothing more (§6). The rows are kept.
  if (diff.disappeared.length > 0) {
    await deps.postings.markUnlisted(board.id, diff.disappeared, now);
  }

  await deps.snapshots.save({
    id: newSnapshotId(),
    boardId: board.id,
    runId,
    takenAt,
    status: "ok",
    errorReason: null,
    sourceUrl: fetched.sourceUrl,
    adapterVersion: source.adapterVersion,
    postingCount: entries.length,
    entries,
  });

  await deps.boards.recordFetchOutcome(board.id, { status: "ok", at: now });

  logger.info("board collected", {
    seen: entries.length,
    appeared: diff.appeared.length,
    changed: diff.changed.length,
    disappeared: diff.disappeared.length,
  });

  return {
    boardId: board.id,
    companyName: board.companyName,
    status: "ok",
    postingsSeen: entries.length,
    appeared: diff.appeared.length,
    changed: diff.changed.length,
    disappeared: diff.disappeared.length,
  };
}

export async function collect(
  deps: CollectDeps,
  options: CollectOptions = {},
): Promise<CollectionReport> {
  const runId = options.runId ?? crypto.randomUUID();
  const trigger = options.trigger ?? "manual";
  const startedAt = deps.clock.now();
  const logger = deps.logger.with({ runId });

  const all = await deps.boards.list({ activeOnly: true });
  const selected = options.boardIds === undefined
    ? all
    : all.filter((board) => options.boardIds!.includes(board.id));

  await deps.runs.start({
    id: runId,
    startedAt,
    trigger,
    boardsConfigured: selected.length,
    boardsFetched: 0,
    boardsFailed: 0,
    postingsSeen: 0,
    postingsNew: 0,
    postingsChanged: 0,
    postingsDisappeared: 0,
  });

  logger.info("collection run started", { boards: selected.length, trigger });

  const outcomes: BoardOutcome[] = [];
  for (const board of selected) {
    try {
      outcomes.push(await collectBoard(deps, board, runId));
    } catch (error) {
      // Belt and braces: collectBoard handles its own failures, but a bug in it
      // must still not abort the run (§12).
      logger.error("board collection raised unexpectedly", { boardId: board.id, error });
      outcomes.push({
        boardId: board.id,
        companyName: board.companyName,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        postingsSeen: 0,
        appeared: 0,
        changed: 0,
        disappeared: 0,
      });
    }
  }

  const sum = (pick: (outcome: BoardOutcome) => number) =>
    outcomes.reduce((total, outcome) => total + pick(outcome), 0);

  const report: CollectionReport = {
    id: runId,
    startedAt,
    finishedAt: deps.clock.now(),
    trigger,
    boardsConfigured: selected.length,
    boardsFetched: outcomes.filter((o) => o.status === "ok").length,
    boardsFailed: outcomes.filter((o) => o.status === "failed").length,
    postingsSeen: sum((o) => o.postingsSeen),
    postingsNew: sum((o) => o.appeared),
    postingsChanged: sum((o) => o.changed),
    postingsDisappeared: sum((o) => o.disappeared),
    boards: outcomes,
  };

  await deps.runs.finish(report);
  logger.info("collection run finished", {
    fetched: report.boardsFetched,
    failed: report.boardsFailed,
    seen: report.postingsSeen,
    new: report.postingsNew,
    changed: report.postingsChanged,
    disappeared: report.postingsDisappeared,
  });

  return report;
}
