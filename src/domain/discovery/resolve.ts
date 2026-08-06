/**
 * Turning a company name into a board (§4, §12).
 *
 * The registry is the denominator for every count in this application, so a
 * board that is annoying to add is a board that does not get added — and the
 * coverage ledger then honestly reports a number computed against a smaller
 * denominator than it should be. This is the one place where friction in the
 * interface directly corrupts the data.
 *
 * There is no catalogue to look a company up in. None of the three implemented
 * platforms publishes a directory of its own customers: the feeds exist so a
 * company can build its own careers page, and enumerating every tenant is not a
 * use case any of them serves. What they *do* all answer, cheaply and without
 * authentication, is "is there a board at this name?" — 404 for no, 200 for
 * yes. So this guesses well and then asks, rather than making the user guess.
 *
 * Slug generation and URL reading here are pure. The use case below them is
 * orchestration over ports, in the manner of `collect.ts`: it knows nothing
 * about HTTP, Postgres or any platform's payload shape.
 */

import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import { assertValidSlug, IdError, isPlatform, type Platform, PLATFORMS } from "@platform/ids.ts";
import type { BoardSource } from "./types.ts";

/** A slug worth trying, and the rule that produced it — so a hit is explicable. */
export interface SlugCandidate {
  readonly slug: string;
  readonly rule: "as-typed" | "joined" | "hyphenated" | "first-word" | "hq-suffix";
}

/**
 * Dropped from the end of a company name before slugging. Only ever from the
 * end, and never when it would leave nothing behind — "Co-op" must not become
 * "op".
 */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "holdings",
  "group",
  "gmbh",
  "plc",
  "nv",
  "bv",
  "ab",
  "oy",
  "pty",
  "srl",
  "spa",
  "ag",
  "kk",
]);

const MAX_CANDIDATES = 4;

/**
 * Company name to word list. Diacritics are folded because slugs are ASCII
 * ("Estée Lauder" → `esteelauder`), and apostrophes are removed rather than
 * split on, so "Ben & Jerry's" yields `benjerrys` and not `ben-jerry-s`.
 */
function words(companyName: string): string[] {
  const folded = companyName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['‘’´`]/g, "")
    .toLowerCase();

  const parts = folded.split(/[^a-z0-9]+/).filter((part) => part !== "");
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  return parts;
}

/**
 * Candidate slugs in the order most likely to hit, deduplicated. Four is the
 * cap: every extra candidate is three more requests, and the fifth guess has
 * never been the right one in the boards already registered.
 */
export function candidateSlugs(companyName: string): SlugCandidate[] {
  const parts = words(companyName);
  if (parts.length === 0) return [];

  const joined = parts.join("");
  const ordered: SlugCandidate[] = [{ slug: joined, rule: "joined" }];

  if (parts.length > 1) {
    ordered.push({ slug: parts.join("-"), rule: "hyphenated" });
    ordered.push({ slug: parts[0] ?? joined, rule: "first-word" });
  }
  // Ashby and Lever tenants often append it, and Greenhouse ones sometimes do.
  ordered.push({ slug: `${joined}hq`, rule: "hq-suffix" });

  const seen = new Set<string>();
  const unique: SlugCandidate[] = [];
  for (const candidate of ordered) {
    if (seen.has(candidate.slug)) continue;
    try {
      assertValidSlug(candidate.slug);
    } catch (error) {
      if (error instanceof IdError) continue;
      throw error;
    }
    seen.add(candidate.slug);
    unique.push(candidate);
    if (unique.length === MAX_CANDIDATES) break;
  }
  return unique;
}

/**
 * The lazy path: paste the careers-page URL instead of naming the company. When
 * this matches there is nothing to guess, so the caller probes one pair rather
 * than a dozen.
 *
 * Both the human-facing host and the API host are recognised for each platform,
 * because the URL to hand is as often one as the other.
 */
export function parseBoardUrl(input: string): { platform: Platform; slug: string } | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");

  /** The path segment that follows a fixed prefix, or the first one. */
  const after = (...prefix: string[]): string | null => {
    for (const [index, expected] of prefix.entries()) {
      if (segments[index] !== expected) return null;
    }
    return segments[prefix.length] ?? null;
  };

  let platform: Platform | null = null;
  let slug: string | null = null;

  if (host === "boards-api.greenhouse.io") {
    platform = "greenhouse";
    slug = after("v1", "boards");
  } else if (host.endsWith("greenhouse.io")) {
    // boards.greenhouse.io, job-boards.greenhouse.io, boards.eu.greenhouse.io
    platform = "greenhouse";
    slug = after();
  } else if (host === "api.lever.co") {
    platform = "lever";
    slug = after("v0", "postings");
  } else if (host.endsWith("lever.co")) {
    platform = "lever";
    slug = after();
  } else if (host === "api.ashbyhq.com") {
    platform = "ashby";
    slug = after("posting-api", "job-board");
  } else if (host.endsWith("ashbyhq.com")) {
    platform = "ashby";
    slug = after();
  }

  if (platform === null || slug === null || !isPlatform(platform)) return null;
  const decoded = decodeURIComponent(slug);
  try {
    assertValidSlug(decoded);
  } catch {
    return null;
  }
  return { platform, slug: decoded };
}

/**
 * What asking a platform about one slug established. A miss is a result, not an
 * error: "Spotify is not on Greenhouse" is worth recording so it is not
 * rediscovered on every lookup.
 */
export interface BoardCandidate {
  readonly platform: Platform;
  readonly slug: string;
  readonly found: boolean;
  /** The company's own name, where the platform states one. Greenhouse does. */
  readonly companyName?: string;
  /** Only for a board that was read end to end by its real adapter. */
  readonly postingCount?: number;
  readonly sampleTitles?: readonly string[];
  /**
   * A non-404 problem — a timeout, a 500, a payload the adapter could not
   * parse. Distinct from `found: false`, which is the platform answering
   * clearly. The two must not be conflated: one means "no board here", the
   * other means "we could not find out".
   */
  readonly error?: string;
  /** When this was established. Rendered, per §5 — every value shows its as-of. */
  readonly checkedAt: Date;
}

/** The catalogue: everything this installation has ever asked, hit or miss. */
export interface BoardCandidateRepo {
  /** Cached answers for these exact pairs, whatever their age. */
  lookup(
    pairs: readonly { platform: Platform; slug: string }[],
  ): Promise<BoardCandidate[]>;
  /** `query` is the text the user typed; kept for readability, not for lookup. */
  record(candidate: BoardCandidate, query?: string): Promise<void>;
  /** Everything known, newest first. The catalogue as it has accumulated. */
  recent(limit: number): Promise<BoardCandidate[]>;
}

/**
 * How long a recorded answer is reused before asking again. Deliberately
 * generous for a miss — a company that moves onto Greenhouse next quarter
 * should be findable next quarter, not never — and short for a hit, because a
 * hit carries a posting count that goes stale.
 *
 * Neither is a cliff: the page shows the as-of time and offers to ask again.
 */
export const HIT_TTL_MS = 24 * 60 * 60 * 1000;
export const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isFresh(candidate: BoardCandidate, now: Date): boolean {
  const age = now.getTime() - candidate.checkedAt.getTime();
  return age < (candidate.found ? HIT_TTL_MS : MISS_TTL_MS);
}

/* ------------------------------------------------------------ use case ---- */

/** The adapter's side of the question, as the domain sees it. */
export type BoardProbe = (
  platform: Platform,
  slug: string,
) => Promise<{ found: boolean; companyName?: string; error?: string }>;

export interface ResolveDeps {
  readonly candidates: BoardCandidateRepo;
  readonly probe: BoardProbe;
  /** Confirmed hits are read by the real adapter, not a second parser. */
  readonly sourceFor: (platform: Platform) => BoardSource | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ResolveOptions {
  /** Ignore anything cached and ask again. The page offers this explicitly. */
  readonly refresh?: boolean;
}

export interface ResolveReport {
  readonly query: string;
  /** A pasted board URL needs no guessing, and the page says which happened. */
  readonly interpretedAs: "url" | "company-name";
  readonly tried: readonly SlugCandidate[];
  /** Hits first, then things that went wrong, then clean misses. */
  readonly results: readonly BoardCandidate[];
  /** True when nothing was asked because every answer was already known. */
  readonly fromCache: boolean;
}

const SAMPLE_TITLES = 3;

/** Platforms with an adapter. The rest cannot be probed or read afterwards. */
function probablePlatforms(sourceFor: ResolveDeps["sourceFor"]): Platform[] {
  return PLATFORMS.filter((platform) => sourceFor(platform) !== null);
}

/**
 * Read a confirmed board with its real adapter, for the posting count and a few
 * titles. This is what tells a genuine Esri from a company that merely shares
 * the name, and it doubles as proof the adapter can parse the board *before* it
 * joins the registry.
 */
async function describe(
  platform: Platform,
  slug: string,
  deps: ResolveDeps,
): Promise<{ postingCount?: number; sampleTitles?: string[]; error?: string }> {
  const source = deps.sourceFor(platform);
  if (source === null) return {};
  try {
    const result = await source.fetchBoard(slug);
    return {
      postingCount: result.postings.length,
      sampleTitles: result.postings.slice(0, SAMPLE_TITLES).map((posting) => posting.title),
    };
  } catch (error) {
    // The board is there; we just could not read it. That is worth saying out
    // loud rather than silently showing a hit with no detail.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Hits, then failures to find out, then clean misses. */
function byUsefulness(a: BoardCandidate, b: BoardCandidate): number {
  const rank = (c: BoardCandidate) => (c.found ? 0 : c.error !== undefined ? 1 : 2);
  return rank(a) - rank(b) || (b.postingCount ?? 0) - (a.postingCount ?? 0);
}

/**
 * Resolve a company name — or a pasted board URL — to the boards that exist.
 *
 * Candidates are tried in order and **a platform stops at its first hit**: once
 * Greenhouse has answered yes to `esri`, asking it about `esrihq` costs a
 * request to learn nothing. Platforms run concurrently, which the polite
 * fetcher permits because its one-per-second rule is per host.
 */
export async function resolveBoards(
  query: string,
  deps: ResolveDeps,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const now = deps.clock.now();
  const direct = parseBoardUrl(query);
  const tried: SlugCandidate[] = direct !== null
    ? [{ slug: direct.slug, rule: "as-typed" }]
    : candidateSlugs(query);

  if (tried.length === 0) {
    return { query, interpretedAs: "company-name", tried: [], results: [], fromCache: true };
  }

  const platforms = direct !== null ? [direct.platform] : probablePlatforms(deps.sourceFor);
  const pairs = platforms.flatMap((platform) =>
    tried.map((candidate) => ({ platform, slug: candidate.slug }))
  );

  const cached = new Map<string, BoardCandidate>();
  if (options.refresh !== true) {
    for (const candidate of await deps.candidates.lookup(pairs)) {
      if (isFresh(candidate, now)) cached.set(`${candidate.platform}:${candidate.slug}`, candidate);
    }
  }

  let asked = 0;

  const perPlatform = await Promise.all(platforms.map(async (platform) => {
    const found: BoardCandidate[] = [];
    for (const candidate of tried) {
      const key = `${platform}:${candidate.slug}`;
      const known = cached.get(key);
      if (known !== undefined) {
        found.push(known);
        if (known.found) break;
        continue;
      }

      asked++;
      const probe = await deps.probe(platform, candidate.slug);
      const detail = probe.found ? await describe(platform, candidate.slug, deps) : {};
      const record: BoardCandidate = {
        platform,
        slug: candidate.slug,
        found: probe.found,
        checkedAt: now,
        ...(probe.companyName !== undefined ? { companyName: probe.companyName } : {}),
        ...(detail.postingCount !== undefined ? { postingCount: detail.postingCount } : {}),
        ...(detail.sampleTitles !== undefined ? { sampleTitles: detail.sampleTitles } : {}),
        ...(probe.error ?? detail.error ? { error: probe.error ?? detail.error } : {}),
      };
      await deps.candidates.record(record, query);
      found.push(record);
      // A platform that has answered yes has nothing left to tell us.
      if (record.found) break;
    }
    return found;
  }));

  const results = perPlatform.flat().sort(byUsefulness);
  deps.logger.info("board lookup", {
    query,
    interpretedAs: direct !== null ? "url" : "company-name",
    candidates: tried.length,
    asked,
    hits: results.filter((r) => r.found).length,
  });

  return {
    query,
    interpretedAs: direct !== null ? "url" : "company-name",
    tried,
    results,
    fromCache: asked === 0,
  };
}
