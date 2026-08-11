/**
 * Vocabulary gaps (§10, M7).
 *
 * M3 answers this per posting: which passages of *this* job have no strong
 * support anywhere in the profile. This answers it across the corpus: which
 * terms keep appearing in the jobs you are actually matching, and appear
 * nowhere in what you have written about yourself.
 *
 * The honest limit, stated everywhere this is rendered: **a gap cannot tell a
 * missing skill from a missing word.** "Terraform" appearing in nineteen
 * postings and nowhere in your profile might mean you have never used it, or it
 * might mean you wrote "infrastructure as code" and never named the tool. Those
 * need opposite responses, and nothing here can distinguish them — so it
 * reports the observation and refuses to draw the conclusion.
 *
 * No model is involved. This is counting, and counting is checkable: every term
 * comes with the postings it came from, so the reader can go and look.
 */

/** A document to be scanned for terms. */
export interface TermDocument {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface VocabularyGap {
  readonly term: string;
  /** How many of the examined postings use it. The number that ranks the list. */
  readonly postingCount: number;
  /** A few of them, by name, so the term can be checked rather than believed. */
  readonly examples: readonly { readonly id: string; readonly label: string }[];
  /** Present in the matching profile — the text embeddings actually see. */
  readonly inProfile: boolean;
  /** Present in the fact set — the text a resume is built from. */
  readonly inDossier: boolean;
}

export type GapKind = "unknown-territory" | "not-on-the-resume" | "not-in-the-profile";

/**
 * Which of the two corpora a term is missing from, which is the difference
 * between three genuinely different situations.
 */
export function gapKind(gap: VocabularyGap): GapKind {
  if (!gap.inProfile && !gap.inDossier) return "unknown-territory";
  if (gap.inProfile && !gap.inDossier) return "not-on-the-resume";
  return "not-in-the-profile";
}

export interface VocabularyReport {
  readonly gaps: readonly VocabularyGap[];
  /** The denominator. A gap count without it says nothing (§10). */
  readonly postingsExamined: number;
  /** Distinct terms seen at least `minPostings` times, before the corpus filter. */
  readonly termsConsidered: number;
  readonly minPostings: number;
}

export interface VocabularyOptions {
  /** A term in one posting is that posting's vocabulary, not the market's. */
  readonly minPostings?: number;
  readonly limit?: number;
  readonly examplesPerTerm?: number;
}

export const DEFAULT_VOCABULARY_OPTIONS = {
  minPostings: 3,
  limit: 60,
  examplesPerTerm: 3,
} as const;

/**
 * Ordinary English, plus the words every job posting contains regardless of the
 * job. The second group is the judgement call in this module, so it is written
 * out rather than generated: each of these carries no information about what a
 * role actually needs, and leaving them in would bury the terms that do.
 *
 * Written as text rather than as an array of string literals so that it reads
 * like the word list it is.
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  `
    a about above across after against all also an and any are as at be because been before
    being below between both but by can could did do does doing down during each few for from
    further had has have having he her here hers him his how i if in into is it its itself just
    may me might more most must my no nor not of off on once only or other our ours out over
    own same shall she should so some such than that the their theirs them then there these
    they this those through to too under until up very was we were what when where which while
    who whom why will with would you your yours
  `.split(/\s+/).filter((word) => word !== "").concat(
    // Job-posting boilerplate. Present in every posting, informative in none.
    `
    ability able across applicants application apply background benefits candidate candidates
    career colleagues company compensation culture customers day degree diverse diversity
    employee employees employer employment environment equal etc excellent experience
    experienced flexible get global great grow growing growth help including inclusion
    inclusive job join learn level like look looking love make many mission need needs new
    offer one opportunity organization people plus position preferred provide range required
    requirements responsible role salary senior skills someone strong team teams us use using
    want work working world year years you'll your
    `.split(/\s+/).filter((word) => word !== ""),
  ),
);

/**
 * A hex string long enough and containing at least one digit is a hash or
 * database id, not a word: English mixes letters and digits (`c++`, `s3`,
 * `web3`) but never restricts itself to `0-9a-f` while doing it, so this
 * rule has no real-word false positives to guard against. The length floor
 * keeps short legitimate hex-only words (`cab`, `dead`, `face`) out of reach.
 * A dashed UUID (`8-4-4-4-12` hex groups) is caught separately since the
 * dashes break the contiguous-hex check.
 */
const HEX_ID = /^[0-9a-f]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_HEX_ID_LENGTH = 12;

function looksLikeId(token: string): boolean {
  if (UUID.test(token)) return true;
  return token.length >= MIN_HEX_ID_LENGTH && HEX_ID.test(token) && /\d/.test(token);
}

/**
 * Tokens keep the punctuation that is part of a name — `c++`, `c#`, `node.js`,
 * `.net`, `ci/cd` — and lose the punctuation that is grammar. Getting this
 * wrong is how a vocabulary report ends up recommending "c" and "js".
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#./-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}.]+/u, "").replace(/[.,\-/]+$/u, ""))
    .filter((token) => token.length >= 2 && token.length <= 40)
    // A bare number is never a skill.
    .filter((token) => !/^[\d.]+$/.test(token))
    // Nor is a tracking id, a commit hash or a UUID that leaked into a
    // posting's text — it names a record, not a skill.
    .filter((token) => !looksLikeId(token));
}

function isContentWord(token: string): boolean {
  return !STOPWORDS.has(token);
}

/** A document with no term in common with the profile — a candidate to write about. */
export interface UncoveredDocument {
  readonly id: string;
  readonly label: string;
}

/**
 * Documents sharing zero terms with `profileText` — the fact-set half of a
 * writing prompt (M12): "you wrote this, but nothing in your profile reflects
 * it yet."
 *
 * Deliberately blunt, not fuzzy: any single shared word — including an
 * unrelated one, like both texts happening to say "built" — counts as
 * coverage and drops a document from the list. That is the same honest limit
 * the rest of this module accepts: counting is checkable, guessing at
 * relatedness is not. A shrunken candidate pool from a large profile is the
 * visible cost of that choice.
 */
export function findUncoveredDocuments(
  documents: readonly TermDocument[],
  profileText: string,
): UncoveredDocument[] {
  const profileTerms = termsIn(profileText);
  const uncovered: UncoveredDocument[] = [];
  for (const doc of documents) {
    const terms = termsIn(doc.text);
    if (terms.size === 0) continue; // nothing to compare — not a prompt candidate
    const covered = [...terms].some((term) => profileTerms.has(term));
    if (!covered) uncovered.push({ id: doc.id, label: doc.label });
  }
  return uncovered;
}

/**
 * Where a phrase cannot reach across. Sentence-ending punctuation only counts
 * when whitespace follows it, so `node.js` and `.net` survive; newlines end a
 * segment outright, which is what separates a title from its body and one
 * bullet from the next.
 *
 * Without this, "…owns the platform. Kubernetes experience required" yields the
 * phrase "platform kubernetes", which nobody wrote and which would then be
 * reported as a gap.
 */
const SEGMENT_BREAK = /[\n\r•|]+|[.;:!?,)(\]["]+(?=\s|$)/;

/** Unigrams and adjacent pairs. Pairs matter: "incident response" is not two words. */
export function termsIn(text: string): Set<string> {
  const terms = new Set<string>();
  for (const segment of text.split(SEGMENT_BREAK)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!isContentWord(token)) continue;
      terms.add(token);
      const next = tokens[i + 1];
      // A pair is only a phrase if both halves carry meaning; "of the" is not one.
      if (next !== undefined && isContentWord(next)) terms.add(`${token} ${next}`);
    }
  }
  return terms;
}

/**
 * Terms recurring in the postings and absent from what you have written.
 *
 * Document frequency, not term frequency: a posting that says "kubernetes"
 * eleven times is one posting that wants Kubernetes.
 */
export function findVocabularyGaps(
  postings: readonly TermDocument[],
  profileText: string,
  dossierText: string,
  options: VocabularyOptions = {},
): VocabularyReport {
  const minPostings = options.minPostings ?? DEFAULT_VOCABULARY_OPTIONS.minPostings;
  const limit = options.limit ?? DEFAULT_VOCABULARY_OPTIONS.limit;
  const examplesPerTerm = options.examplesPerTerm ?? DEFAULT_VOCABULARY_OPTIONS.examplesPerTerm;

  const profileTerms = termsIn(profileText);
  const dossierTerms = termsIn(dossierText);

  const seen = new Map<string, { id: string; label: string }[]>();
  for (const posting of postings) {
    // A newline between them: the title is its own segment, so no phrase is
    // invented by running the last word of one into the first of the other.
    for (const term of termsIn(`${posting.label}\n${posting.text}`)) {
      const sources = seen.get(term);
      if (sources === undefined) seen.set(term, [{ id: posting.id, label: posting.label }]);
      else sources.push({ id: posting.id, label: posting.label });
    }
  }

  const frequent = [...seen.entries()].filter(([, sources]) => sources.length >= minPostings);

  const gaps: VocabularyGap[] = frequent
    .filter(([term]) => !profileTerms.has(term) || !dossierTerms.has(term))
    .map(([term, sources]) => ({
      term,
      postingCount: sources.length,
      examples: sources.slice(0, examplesPerTerm),
      inProfile: profileTerms.has(term),
      inDossier: dossierTerms.has(term),
    }));

  // A phrase subsumes its parts. If "incident response" appears in exactly the
  // postings "incident" does, listing both says the same thing twice and buries
  // the more specific one.
  const byTerm = new Map(gaps.map((gap) => [gap.term, gap]));
  const subsumed = new Set<string>();
  for (const gap of gaps) {
    const words = gap.term.split(" ");
    if (words.length !== 2) continue;
    for (const word of words) {
      const unigram = byTerm.get(word);
      if (unigram !== undefined && unigram.postingCount === gap.postingCount) {
        subsumed.add(word);
      }
    }
  }

  const ranked = gaps
    .filter((gap) => !subsumed.has(gap.term))
    .sort((a, b) =>
      b.postingCount - a.postingCount ||
      // Longer terms first at equal frequency: the specific over the generic.
      b.term.length - a.term.length ||
      a.term.localeCompare(b.term)
    )
    .slice(0, limit);

  return {
    gaps: ranked,
    postingsExamined: postings.length,
    termsConsidered: frequent.length,
    minPostings,
  };
}
