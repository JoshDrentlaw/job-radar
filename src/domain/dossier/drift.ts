/**
 * Drift detection for proposed rewrites (§8 rule 4).
 *
 * "Run a similarity check between each rewrittenText and its source text.
 * Below a threshold, flag it for review rather than accepting it — that is
 * where meaning drift and invented specifics show up."
 *
 * Two signals, both computed locally:
 *
 *  - **Token overlap** catches wholesale rewrites: a "rewording" that retains
 *    little of the original is not a rewording.
 *  - **Novel specifics** catches the more dangerous case — numbers and proper
 *    nouns present in the rewrite but absent from the source. That is exactly
 *    the shape of an invented metric ("improved throughput by 40%") or an
 *    invented technology ("using Kubernetes"), and it is where fabrication
 *    actually shows up in practice.
 *
 * An embedding call would measure semantic similarity better but would miss
 * invented specifics entirely — a fabricated number is highly similar to its
 * source. These are lexical on purpose, and free.
 */

export interface DriftReport {
  /** Containment of the source's meaningful tokens, 0..1. */
  readonly similarity: number;
  /** Numbers and proper nouns the source never mentioned. */
  readonly novelTerms: readonly string[];
  /** True when this rewrite needs a closer look before acceptance. */
  readonly flagged: boolean;
}

/** Below this overlap, the "rewrite" has drifted far from its source. */
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * Words too common to carry meaning. Kept short deliberately: a long stop list
 * would strip the domain vocabulary this check exists to compare.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

/**
 * Tokens keep the punctuation that is part of a word — `c++`, `40%`, `node.js`,
 * `$120k` — but shed the punctuation that merely ended a sentence. Without the
 * trailing strip, `fleet.` never matches `fleet` and `40%.` is reported as a
 * novel term distinct from `40%`.
 */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$.+#-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}$]+/u, "").replace(/[.,\-]+$/u, ""))
    .filter((token) => token !== "");
}

function meaningfulTokens(text: string): Set<string> {
  return new Set(normalize(text).filter((token) => !STOP_WORDS.has(token)));
}

/**
 * Containment of the source in the rewrite: what share of the source's
 * meaningful words survive. Asymmetric on purpose — dropping content is the
 * drift we care about, and a rewrite that adds words is not penalized here
 * (novel specifics cover that side).
 */
function containment(source: Set<string>, rewrite: Set<string>): number {
  if (source.size === 0) return rewrite.size === 0 ? 1 : 0;
  let kept = 0;
  for (const token of source) if (rewrite.has(token)) kept += 1;
  return kept / source.size;
}

const NUMERIC = /\d/u;

/** A capitalized word that is not merely sentence-initial. */
function properNouns(text: string): string[] {
  const words = text.split(/\s+/);
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const bare = words[i]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");
    if (bare === "") continue;
    const first = bare[0]!;
    // Sentence-initial capitals are ordinary; mid-sentence ones name things.
    const sentenceInitial = i === 0 || /[.!?]$/.test(words[i - 1] ?? "");
    if (!sentenceInitial && first === first.toUpperCase() && first !== first.toLowerCase()) {
      found.push(bare);
    }
  }
  return found;
}

/** Numbers, percentages and money — the classic invented metric. */
function figures(text: string): string[] {
  return normalize(text).filter((token) => NUMERIC.test(token));
}

export function checkDrift(sourceText: string, rewrittenText: string): DriftReport {
  const source = meaningfulTokens(sourceText);
  const rewrite = meaningfulTokens(rewrittenText);
  const similarity = containment(source, rewrite);

  const sourceLower = new Set(normalize(sourceText));
  const novel = new Set<string>();
  for (const term of [...figures(rewrittenText), ...properNouns(rewrittenText)]) {
    if (!sourceLower.has(term.toLowerCase())) novel.add(term);
  }
  const novelTerms = [...novel].sort();

  return {
    similarity,
    novelTerms,
    // Either signal is enough to warrant a closer look. Flagging is advisory:
    // §8 requires every rewrite be reviewed regardless, so this only decides
    // what gets the reviewer's attention first.
    flagged: similarity < SIMILARITY_THRESHOLD || novelTerms.length > 0,
  };
}
