/**
 * Matching types and ports (§7).
 *
 * The skill profile is long-form markdown split into named facets; postings
 * and facets are both embedded in overlapping chunks; a match is the best
 * chunk pair for a (posting, facet), stored with its raw similarity. Buckets
 * are applied at read time from thresholds in the settings table, so tuning
 * re-buckets existing scores instead of invalidating them.
 */

import type { BoardId, FacetId, PostingId } from "@platform/ids.ts";
import { sha256Hex } from "@platform/hash.ts";

export interface ProfileFacet {
  readonly id: FacetId;
  readonly name: string;
  /** Long-form markdown, authored in the app. */
  readonly content: string;
  readonly active: boolean;
  /** sha256 of content. Vectors and matches cite it; staleness is a comparison. */
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FacetInput {
  readonly id?: FacetId;
  readonly name: string;
  readonly content: string;
  readonly active?: boolean;
}

export function facetContentHash(content: string): Promise<string> {
  return sha256Hex(content);
}

/**
 * The embedding port (§4). `kind` follows retrieval convention: postings are
 * the documents being searched, profile facets are the standing queries.
 */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[], kind: "document" | "query"): Promise<number[][]>;
}

export interface PostingChunkScore {
  readonly seq: number;
  readonly text: string;
  /** Best similarity across all active facet chunks; null until scored. */
  readonly bestScore: number | null;
}

/** A (posting, facet) pair whose match record is missing or stale. */
export interface StalePair {
  readonly postingId: PostingId;
  readonly facetId: FacetId;
  readonly postingContentHash: string;
  readonly facetContentHash: string;
}

/** A match candidate as browsed: the record plus what the UI needs to cite it. */
export interface MatchCandidate {
  readonly postingId: PostingId;
  readonly boardId: BoardId;
  readonly title: string;
  readonly companyName: string;
  readonly locationRaw: string;
  readonly currentlyListed: boolean;
  readonly firstSeenAt: Date;
  readonly fetchedAt: Date;
  readonly facetId: FacetId;
  readonly facetName: string;
  readonly score: number;
  /** The exact passage that matched, verbatim (§7). */
  readonly matchedChunk: string;
  readonly scoredAt: Date;
}

export interface ScoreRow {
  readonly postingId: PostingId;
  readonly title: string;
  readonly companyName: string;
  readonly facetName: string;
  readonly score: number;
  readonly scoredAt: Date;
}

/** Ports. Implementations live in adapters; fakes live in tests. */

export interface FacetRepo {
  list(): Promise<ProfileFacet[]>;
  get(id: FacetId): Promise<ProfileFacet | null>;
  upsert(input: FacetInput): Promise<ProfileFacet>;
  remove(id: FacetId): Promise<void>;
  /**
   * Active facets with no fresh chunk vectors for this model and chunker
   * version. A row chunked under an older chunkerVersion is stale even when
   * its content hasn't changed — the splitter that produced it has (§7).
   */
  staleForModel(model: string, chunkerVersion: string): Promise<ProfileFacet[]>;
}

export interface StalePosting {
  readonly id: PostingId;
  readonly title: string;
  readonly descriptionText: string;
  readonly contentHash: string;
}

export interface EmbeddedChunk {
  readonly seq: number;
  readonly text: string;
  readonly embedding: readonly number[];
}

export interface ChunkRepo {
  /**
   * Listed postings with no fresh chunk vectors for this model and chunker
   * version, oldest first. A row chunked under an older chunkerVersion is
   * stale even when its content hasn't changed — the splitter that
   * produced it has (§7).
   */
  stalePostings(model: string, chunkerVersion: string, limit: number): Promise<StalePosting[]>;
  /** How many postings stalePostings would still return. */
  stalePostingCount(model: string, chunkerVersion: string): Promise<number>;
  replacePostingChunks(
    postingId: PostingId,
    model: string,
    chunkerVersion: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
    at: Date,
  ): Promise<void>;
  replaceFacetChunks(
    facetId: FacetId,
    model: string,
    chunkerVersion: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
    at: Date,
  ): Promise<void>;
  /** Chunk texts and best-scores for one posting, for the gap view (§7). */
  postingChunkScores(postingId: PostingId, model: string): Promise<PostingChunkScore[]>;
  /** Embed-status summary per facet, keyed by facet id. */
  facetEmbedStatus(model: string): Promise<Map<FacetId, { chunks: number; embeddedAt: Date }>>;
}

export interface MatchRepo {
  stalePairs(model: string): Promise<StalePair[]>;
  /**
   * Score one stale pair from its stored vectors and upsert the match row.
   * Returns null when either side has no fresh vectors (nothing to score yet).
   */
  scorePair(pair: StalePair, model: string, at: Date): Promise<number | null>;
  /** Recompute posting_chunks.best_score for these postings. */
  refreshBestScores(postingIds: readonly PostingId[], model: string, at: Date): Promise<void>;
  /** Candidates for the match browser: listed postings only. */
  listCandidates(opts?: { facetId?: FacetId; limit?: number }): Promise<MatchCandidate[]>;
  /** Every match for one posting, all facets, for the detail view. */
  forPosting(postingId: PostingId): Promise<MatchCandidate[]>;
  /** Raw score rows for the tuning page and its CSV export (§7). */
  allScores(): Promise<ScoreRow[]>;
}

/** Buckets (§7). Raw floats stay out of the main UI. */

export type MatchBucket = "strong" | "plausible" | "weak";

export interface BucketThresholds {
  /** Scores at or above this are strong. */
  readonly strong: number;
  /** Scores at or above this (and below strong) are plausible. */
  readonly plausible: number;
}

/**
 * Placeholder until the tuning page has real score distributions to set them
 * with (§7) — that is exactly why they live in settings, not here.
 */
export const DEFAULT_BUCKET_THRESHOLDS: BucketThresholds = {
  strong: 0.6,
  plausible: 0.5,
};

export const BUCKET_THRESHOLDS_SETTING = "match.bucket_thresholds";

export function bucketOf(score: number, thresholds: BucketThresholds): MatchBucket {
  if (score >= thresholds.strong) return "strong";
  if (score >= thresholds.plausible) return "plausible";
  return "weak";
}

export class ThresholdError extends Error {
  override readonly name = "ThresholdError";
}

export function validateThresholds(strong: number, plausible: number): BucketThresholds {
  for (const [label, value] of [["strong", strong], ["plausible", plausible]] as const) {
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw new ThresholdError(`The ${label} threshold must be a number between -1 and 1.`);
    }
  }
  if (plausible > strong) {
    throw new ThresholdError("The plausible threshold cannot exceed the strong threshold.");
  }
  return { strong, plausible };
}

/** Key/value settings port (app.settings): tuning knobs, never secrets (§11). */
export interface SettingsRepo {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export async function loadBucketThresholds(settings: SettingsRepo): Promise<BucketThresholds> {
  const stored = await settings.get<BucketThresholds>(BUCKET_THRESHOLDS_SETTING);
  if (stored === null) return DEFAULT_BUCKET_THRESHOLDS;
  try {
    return validateThresholds(stored.strong, stored.plausible);
  } catch {
    // A corrupt row must not take the match views down with it.
    return DEFAULT_BUCKET_THRESHOLDS;
  }
}
