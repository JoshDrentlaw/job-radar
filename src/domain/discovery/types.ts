/**
 * Discovery domain types (§5).
 *
 * The central distinction in this file is between what a feed asserted and what
 * we computed. `SourcePosting` is strictly the former — an adapter may not put a
 * guess in it. Everything derived lives in `DerivedFields`, carries the version
 * of the rules that produced it, and renders visually distinct in the UI.
 */

import type { BoardId, Platform, PostingId } from "@platform/ids.ts";

export type FetchStatus = "ok" | "failed" | "never";
export type RemoteHint = "remote" | "hybrid" | "onsite" | "unknown";

export interface Board {
  readonly id: BoardId;
  readonly platform: Platform;
  readonly slug: string;
  /** Authored by the user, not taken from the feed. */
  readonly companyName: string;
  readonly active: boolean;
  readonly notes?: string;
  readonly tags: readonly string[];
  readonly addedAt: Date;
  readonly lastFetchStatus: FetchStatus;
  readonly lastFetchAt?: Date;
  readonly lastFetchError?: string;
  readonly consecutiveFailures: number;
}

export interface BoardInput {
  readonly platform: Platform;
  readonly slug: string;
  readonly companyName: string;
  readonly active?: boolean;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface Compensation {
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly currency?: string;
  readonly interval?: "year" | "month" | "week" | "day" | "hour";
  /** The source's own wording, kept when the structure is ambiguous. */
  readonly raw?: string;
}

/**
 * Provenance is non-nullable by design (§5): anything rendered in the UI must be
 * able to display its as-of timestamp.
 */
export interface Provenance {
  readonly platform: Platform;
  /** Bumped on parser changes; recorded per posting so old rows stay explicable. */
  readonly adapterVersion: string;
  readonly sourceUrl: string;
  readonly fetchedAt: Date;
  /** Our hash of normalized title + location + description. Authoritative (§6). */
  readonly contentHash: string;
}

/**
 * What an adapter produces: source-asserted fields only. No ids we own, no
 * timestamps we own, no derivation.
 */
export interface SourcePosting {
  readonly externalId: string;
  readonly title: string;
  /** The original string. Normalization happens alongside, never in place. */
  readonly locationRaw: string;
  readonly employmentType?: string;
  readonly department?: string;
  /** The feed's HTML, converted to markdown. */
  readonly descriptionText: string;
  readonly compensation?: Compensation;
  readonly applyUrl: string;
  /** Only when the source actually provides it. */
  readonly postedAt?: Date;
}

export interface DerivedFields {
  readonly locationNormalized: string | null;
  readonly remoteHint: RemoteHint;
  readonly derivationVersion: string;
  readonly derivedAt: Date;
}

export interface Posting extends SourcePosting {
  readonly id: PostingId;
  readonly boardId: BoardId;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /**
   * False means "no longer listed" and nothing more — not filled, not
   * cancelled, not closed (§6).
   */
  readonly currentlyListed: boolean;
  readonly provenance: Provenance;
  readonly derived: DerivedFields | null;
}

/** One adapter fetch of one board. */
export interface FetchResult {
  readonly sourceUrl: string;
  readonly fetchedAt: Date;
  readonly postings: readonly SourcePosting[];
}

/**
 * A complete set of posting ids and content hashes at a point in time (§6).
 * There is no incremental delta tracking; diffs come from comparing two of these.
 */
export interface SnapshotEntry {
  readonly externalId: string;
  readonly contentHash: string;
}

export interface Snapshot {
  readonly id: import("@platform/ids.ts").SnapshotId;
  readonly boardId: BoardId;
  readonly runId: string | null;
  readonly takenAt: Date;
  readonly status: "ok" | "failed";
  readonly errorReason: string | null;
  readonly sourceUrl: string;
  readonly adapterVersion: string;
  /**
   * How many postings this snapshot covered. Carried separately from `entries`
   * because history views load snapshot headers without their entry sets.
   */
  readonly postingCount: number;
  readonly entries: readonly SnapshotEntry[];
}

export interface SnapshotDiff {
  readonly appeared: readonly string[];
  readonly changed: readonly string[];
  /** No longer listed. Says nothing about outcome (§6). */
  readonly disappeared: readonly string[];
  readonly unchanged: readonly string[];
}

/** Ports (§4). The domain knows these; it does not know Postgres or Greenhouse. */

export interface BoardSource {
  readonly platform: Platform;
  readonly adapterVersion: string;
  fetchBoard(slug: string): Promise<FetchResult>;
}

export interface BoardRegistry {
  list(opts?: { activeOnly?: boolean }): Promise<Board[]>;
  get(id: BoardId): Promise<Board | null>;
  upsert(board: BoardInput): Promise<Board>;
  deactivate(id: BoardId): Promise<void>;
  remove(id: BoardId): Promise<void>;
  recordFetchOutcome(
    id: BoardId,
    outcome: { status: "ok" | "failed"; at: Date; error?: string },
  ): Promise<void>;
}

export interface PostingQuery {
  readonly boardId?: BoardId;
  readonly includeUnlisted?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PostingRepo {
  get(id: PostingId): Promise<Posting | null>;
  list(query: PostingQuery): Promise<{ postings: Posting[]; total: number }>;
  /** Insert new postings and update changed ones, returning what it did. */
  upsertMany(postings: readonly Posting[]): Promise<void>;
  markUnlisted(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void>;
  markListed(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void>;
  touchLastSeen(boardId: BoardId, externalIds: readonly string[], at: Date): Promise<void>;
  countByBoard(): Promise<Map<BoardId, { listed: number; total: number }>>;
}

export interface SnapshotRepo {
  save(snapshot: Snapshot): Promise<void>;
  latestSuccessful(boardId: BoardId): Promise<Snapshot | null>;
  recentForBoard(boardId: BoardId, limit: number): Promise<Snapshot[]>;
}
