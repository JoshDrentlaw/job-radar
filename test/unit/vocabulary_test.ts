import { assert, assertEquals } from "@std/assert";
import {
  findUncoveredDocuments,
  findVocabularyGaps,
  gapKind,
  stripBoilerplate,
  type TermDocument,
  termsIn,
  tokenize,
} from "@domain/discovery/vocabulary.ts";

function posting(id: string, label: string, text: string): TermDocument {
  return { id, label, text };
}

function fact(id: string, text: string): TermDocument {
  return { id, label: text, text };
}

function boardPosting(id: string, label: string, text: string, groupId: string): TermDocument {
  return { id, label, text, groupId };
}

Deno.test("tokenize keeps the punctuation that is part of a name", () => {
  const tokens = tokenize("We use C++, C#, Node.js, .NET and CI/CD.");
  assert(tokens.includes("c++"), tokens.join(","));
  assert(tokens.includes("c#"));
  assert(tokens.includes("node.js"));
  assert(tokens.includes(".net"));
  assert(tokens.includes("ci/cd"));
});

Deno.test("tokenize drops grammar punctuation, bare numbers and single letters", () => {
  const tokens = tokenize("Kubernetes, Terraform; 5+ years — a role (remote).");
  assertEquals(tokens.includes("kubernetes"), true);
  assertEquals(tokens.includes("terraform"), true);
  assertEquals(tokens.includes("kubernetes,"), false);
  assertEquals(tokens.includes("a"), false);
  assert(!tokens.some((token) => /^[\d.]+$/.test(token)), "a bare number is never a skill");
});

Deno.test("tokenize drops hash-like ids but keeps real hex-lookalike words and short codes", () => {
  const tokens = tokenize(
    "Requisition id 24d528fddbfc930044f9ff621f961987 for a cafe with a dead deadbeef vibe. " +
      "Session 123e4567-e89b-12d3-a456-426614174000 opened. We use s3 and web3 and c++.",
  );
  assert(!tokens.includes("24d528fddbfc930044f9ff621f961987"), tokens.join(","));
  assert(!tokens.includes("123e4567-e89b-12d3-a456-426614174000"), tokens.join(","));
  assert(tokens.includes("cafe"));
  assert(tokens.includes("dead"));
  assert(tokens.includes("deadbeef"), "no digit, so not id-shaped");
  assert(tokens.includes("s3"));
  assert(tokens.includes("web3"));
  assert(tokens.includes("c++"));
});

Deno.test("tokenize keeps a contraction whole instead of shattering it", () => {
  const tokens = tokenize("You'll love it here — we're a fast-paced, don't-miss opportunity.");
  assert(tokens.includes("you'll"), tokens.join(","));
  assert(tokens.includes("we're"), tokens.join(","));
  assert(!tokens.includes("ll"), "the fragment left by splitting on the apostrophe");
  assert(!tokens.includes("re"), "the fragment left by splitting on the apostrophe");
});

Deno.test("a curly apostrophe is folded to a straight one before tokenizing", () => {
  const tokens = tokenize("We’re looking for someone who isn’t afraid of ambiguity.");
  assert(tokens.includes("we're"), tokens.join(","));
  assert(tokens.includes("isn't"), tokens.join(","));
});

Deno.test("a contraction of two stopwords is not a vocabulary gap", () => {
  const postings = [
    posting("1", "Electrician", "You'll love it here. We've got you. It isn't slow."),
    posting("2", "Propulsion Engineer", "You'll love it here. We've got you. It isn't slow."),
    posting("3", "Mechanical Engineer", "You'll love it here. We've got you. It isn't slow."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 3 }).gaps.map((g) => g.term);
  // Before contractions were kept whole, splitting on the apostrophe left
  // exactly these fragments behind — none of which is a word.
  for (const garbage of ["ll", "ve", "isn", "you'll", "we've", "isn't"]) {
    assertEquals(terms.includes(garbage), false, `"${garbage}" is not something to write about`);
  }
});

Deno.test("job-posting personality filler is not a vocabulary gap", () => {
  const postings = [
    posting("1", "Electrician", "Looking for a fast-paced, detail-oriented self-starter."),
    posting("2", "Propulsion Engineer", "Looking for a fast-paced, detail-oriented self-starter."),
    posting("3", "Mechanical Engineer", "Looking for a fast-paced, detail-oriented self-starter."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 3 }).gaps.map((g) => g.term);
  for (const filler of ["fast-paced", "detail-oriented", "self-starter"]) {
    assertEquals(terms.includes(filler), false, `"${filler}" is filler, not a skill`);
  }
});

Deno.test("a hash that leaked into many postings is not a vocabulary gap", () => {
  const postings = [
    posting("1", "Electrician", "Requisition id 24d528fddbfc930044f9ff621f961987 apply now."),
    posting("2", "Propulsion Engineer", "Requisition id 24d528fddbfc930044f9ff621f961987 apply."),
    posting("3", "Principal Mechanical Engineer", "id 24d528fddbfc930044f9ff621f961987 apply."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 3 }).gaps.map((g) => g.term);
  assertEquals(
    terms.some((term) => term.includes("24d528fddbfc930044f9ff621f961987")),
    false,
    "a leaked hash is not something to write about",
  );
});

Deno.test("a link's url scheme is rendering noise, not a vocabulary gap", () => {
  const postings = [
    posting("1", "Electrician", "Apply at [our site](https://boards.example.com/1)."),
    posting("2", "Propulsion Engineer", "See [details](https://boards.example.com/2) here."),
    posting("3", "Mechanical Engineer", "Visit https://boards.example.com/3 to apply."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 3 }).gaps.map((g) => g.term);
  assertEquals(terms.includes("https"), false, "a url scheme is not something to write about");
});

Deno.test("terms include adjacent pairs, but only between content words", () => {
  const terms = termsIn("Run incident response for the platform");
  assert(terms.has("incident response"), "a phrase is not two words");
  assert(terms.has("incident"));
  // "for the" is grammar; "response for" crosses a stopword boundary.
  assert(!terms.has("for the"));
  assert(!terms.has("response for"));
});

Deno.test("boilerplate present in every posting is not a gap", () => {
  const postings = [
    posting("1", "Engineer", "We are looking for a strong candidate with 5 years of experience."),
    posting("2", "Engineer", "The ideal candidate has experience working on a great team."),
    posting("3", "Engineer", "Experience required. Join our growing team and help us build."),
  ];
  const report = findVocabularyGaps(postings, "", "", { minPostings: 2 });
  const terms = report.gaps.map((gap) => gap.term);
  for (const boilerplate of ["candidate", "experience", "team", "years", "looking"]) {
    assertEquals(terms.includes(boilerplate), false, `${boilerplate} should be filtered`);
  }
});

Deno.test("a term in one posting is that posting's vocabulary, not the market's", () => {
  const postings = [
    posting("1", "Alpha", "Kubernetes. Terraform."),
    posting("2", "Beta", "Kubernetes."),
    posting("3", "Gamma", "Kubernetes."),
  ];
  const report = findVocabularyGaps(postings, "", "", { minPostings: 3 });
  assertEquals(report.gaps.map((gap) => gap.term), ["kubernetes"]);
  assertEquals(report.gaps[0]?.postingCount, 3);
});

Deno.test("frequency is by posting, not by mention", () => {
  const postings = [
    posting("1", "Engineer", "kubernetes kubernetes kubernetes kubernetes kubernetes"),
    posting("2", "Engineer", "kubernetes"),
  ];
  const report = findVocabularyGaps(postings, "", "", { minPostings: 2 });
  assertEquals(
    report.gaps[0]?.postingCount,
    2,
    "five mentions in one posting is still one posting",
  );
});

Deno.test("a term written in both places is not reported at all", () => {
  const postings = [
    posting("1", "Alpha", "We use kubernetes. We use terraform."),
    posting("2", "Beta", "We use kubernetes. We use terraform."),
  ];
  const report = findVocabularyGaps(
    postings,
    "I run Kubernetes clusters.",
    "Ran a Kubernetes fleet.",
    { minPostings: 2 },
  );
  const terms = report.gaps.map((gap) => gap.term);
  assertEquals(terms.includes("kubernetes"), false, "it is in the profile and on the resume");
  assertEquals(terms.includes("terraform"), true, "it is in neither");
});

Deno.test("the three situations are told apart, because they need opposite responses", () => {
  const postings = [
    posting("1", "Alpha", "We use kubernetes. We use terraform. We use postgres."),
    posting("2", "Beta", "We use kubernetes. We use terraform. We use postgres."),
  ];
  const report = findVocabularyGaps(
    postings,
    "I run Kubernetes clusters.", // profile only
    "Managed Postgres in production.", // dossier only
    { minPostings: 2 },
  );
  const byTerm = new Map(report.gaps.map((gap) => [gap.term, gap]));

  // Never mentioned anywhere: might be a missing skill, might be a missing word.
  assertEquals(gapKind(byTerm.get("terraform")!), "unknown-territory");
  // In the profile, absent from the resume: you can do it and the resume is silent.
  assertEquals(gapKind(byTerm.get("kubernetes")!), "not-on-the-resume");
  // On the resume, absent from the profile: matching cannot find those jobs.
  assertEquals(gapKind(byTerm.get("postgres")!), "not-in-the-profile");
});

Deno.test("a phrase subsumes its parts when they came from the same postings", () => {
  const postings = [
    posting("1", "SRE", "incident response matters"),
    posting("2", "SRE", "incident response matters"),
    posting("3", "SRE", "incident response matters"),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 3 }).gaps.map((g) => g.term);
  assert(terms.includes("incident response"));
  assertEquals(terms.includes("incident"), false, "the phrase already said this");
  assertEquals(terms.includes("response"), false);
});

Deno.test("a word that also appears alone survives the phrase that contains it", () => {
  const postings = [
    posting("1", "SRE", "incident response"),
    posting("2", "SRE", "incident response"),
    posting("3", "SRE", "incident management elsewhere"),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 2 }).gaps.map((g) => g.term);
  assert(terms.includes("incident response"));
  assert(terms.includes("incident"), "it appears in three postings, the phrase in two");
});

Deno.test("every term carries the postings it came from, so it can be checked", () => {
  const postings = [
    posting("p1", "Staff SRE at Acme", "terraform"),
    posting("p2", "Platform Engineer at Globex", "terraform"),
    posting("p3", "SRE at Initech", "terraform"),
  ];
  const gap = findVocabularyGaps(postings, "", "", { minPostings: 3, examplesPerTerm: 2 }).gaps[0]!;
  assertEquals(gap.examples.length, 2);
  assertEquals(gap.examples[0], { id: "p1", label: "Staff SRE at Acme" });
});

Deno.test("the report states its denominator", () => {
  const postings = [posting("1", "A", "rust"), posting("2", "B", "rust")];
  const report = findVocabularyGaps(postings, "", "", { minPostings: 2 });
  assertEquals(report.postingsExamined, 2);
  assertEquals(report.minPostings, 2);
  assert(report.termsConsidered >= report.gaps.length);
});

Deno.test("the title is examined too — it is where the role name lives", () => {
  const postings = [
    posting("1", "Staff Rust Engineer", "We build things."),
    posting("2", "Senior Rust Engineer", "We build things."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 2 }).gaps.map((g) => g.term);
  // Reported as the phrase "rust engineer" rather than the bare word, because
  // the phrase covers exactly the same postings and says more.
  assert(terms.some((term) => term.includes("rust")), terms.join(", "));
});

Deno.test("a phrase is never invented across a sentence or a title boundary", () => {
  const postings = [
    posting("1", "Platform Engineer", "You will own the platform. Kubernetes is required."),
    posting("2", "Platform Engineer", "You will own the platform. Kubernetes is required."),
    posting("3", "Platform Engineer", "You will own the platform. Kubernetes is required."),
  ];
  const terms = findVocabularyGaps(postings, "", "", { minPostings: 2 }).gaps.map((g) => g.term);
  assertEquals(terms.includes("platform kubernetes"), false, "nobody wrote that");
  assertEquals(terms.includes("engineer you"), false, "the title does not run into the body");
  assert(terms.includes("kubernetes"));
});

Deno.test("nothing to examine produces an empty report rather than an error", () => {
  const report = findVocabularyGaps([], "profile text", "dossier text");
  assertEquals(report.gaps, []);
  assertEquals(report.postingsExamined, 0);
});

/* -------------------------------------------- boilerplate stripping ------- */

const LEGAL_PARAGRAPH =
  "This company is an Equal Opportunity Employer and does not discriminate on the basis of " +
  "race, color, religion, sex, national origin, disability or veteran status.";

// Distinct words, not numbers, per posting — normalization folds digit runs
// together on purpose (§ a spliced-in number test below), so a "unique"
// sentence that varies only by a trailing digit would collapse into a
// second, accidental template instead of testing real variation.
const CITIES = [
  "Chicago",
  "Boston",
  "Denver",
  "Austin",
  "Seattle",
  "Miami",
  "Reno",
  "Tulsa",
  "Boise",
  "Fargo",
  "Provo",
  "Selma",
];

function boardOf(size: number, uniqueSentence: (city: string) => string): TermDocument[] {
  return Array.from(
    { length: size },
    (_, i) =>
      boardPosting(
        `p${i}`,
        `Role ${i}`,
        `${LEGAL_PARAGRAPH}\n\n${uniqueSentence(CITIES[i]!)}`,
        "acme",
      ),
  );
}

Deno.test("a paragraph pasted into most of a board's own postings is not a vocabulary gap", () => {
  const postings = boardOf(
    12,
    (city) => `We need someone who knows kubernetes and terraform, based in ${city}.`,
  );
  const report = findVocabularyGaps(postings, "", "", { minPostings: 3 });
  const terms = report.gaps.map((g) => g.term);
  assertEquals(terms.includes("discriminate"), false, "legal boilerplate, not a skill");
  assertEquals(terms.includes("veteran status"), false);
  // Subsumed into "knows kubernetes" — same postings, so the phrase alone
  // is kept (§ "a phrase subsumes its parts"). Either way it survived.
  assert(
    terms.some((t) => t.includes("kubernetes")),
    "the genuinely recurring skill term survives",
  );
  assert(report.boilerplateSegmentsRemoved > 0, "the report says the segment was excluded");
});

Deno.test("boilerplate is compared within a board, not across the whole corpus", () => {
  const acme = boardOf(12, (city) => `Acme wants a rust engineer in ${city}.`);
  const globex = Array.from(
    { length: 12 },
    (_, i) =>
      boardPosting(
        `g${i}`,
        `Role ${i}`,
        "Globex requires all applicants to complete a background check before an offer is made.\n\n" +
          `Globex wants a python engineer in ${CITIES[i]}.`,
        "globex",
      ),
  );
  const report = findVocabularyGaps([...acme, ...globex], "", "", { minPostings: 3 });
  const terms = report.gaps.map((g) => g.term);
  assertEquals(terms.includes("discriminate"), false, "acme's own boilerplate is still stripped");
  assertEquals(
    terms.includes("background check"),
    false,
    "globex's own boilerplate is stripped too",
  );
  // Subsumed into "rust engineer" / "python engineer" — same postings each.
  assert(terms.some((t) => t.includes("rust")));
  assert(terms.some((t) => t.includes("python")));
});

Deno.test("a board too small to judge is left alone", () => {
  // Below the minimum group size — "identical in all three" is not evidence
  // of a template, so nothing is stripped and the boilerplate itself is
  // reported like any other recurring term (still correct, just unfiltered).
  const postings = boardOf(3, (city) => `Needs kubernetes experience in ${city}.`);
  const report = findVocabularyGaps(postings, "", "", { minPostings: 3 });
  const terms = report.gaps.map((g) => g.term);
  assert(terms.includes("discriminate"), "too few postings to call this a template");
  assertEquals(report.boilerplateSegmentsRemoved, 0);
});

Deno.test("documents with no groupId are never stripped", () => {
  const documents: TermDocument[] = Array.from(
    { length: 12 },
    (_, i) =>
      posting(`p${i}`, `Role ${i}`, `${LEGAL_PARAGRAPH}\n\nNeeds kubernetes in ${CITIES[i]}.`),
  );
  const { documents: stripped, removedSegments } = stripBoilerplate(documents);
  assertEquals(stripped, documents);
  assertEquals(removedSegments, 0);
});

Deno.test("a number spliced into an otherwise identical template does not defeat the match", () => {
  const postings = Array.from(
    { length: 12 },
    (_, i) =>
      boardPosting(
        `p${i}`,
        `Role ${i}`,
        `Base pay for this role is $${90 + i},000 per year, determined case-by-case.\n\n` +
          `We are hiring a mechanical engineer in ${CITIES[i]}.`,
        "acme",
      ),
  );
  const { documents: stripped, removedSegments } = stripBoilerplate(postings);
  assert(removedSegments > 0, "the templated sentence should match despite the different number");
  for (const doc of stripped) {
    assertEquals(doc.text.includes("determined case-by-case"), false);
    assert(doc.text.includes("mechanical engineer"), "the per-posting sentence is untouched");
  }
});

Deno.test("a segment written independently by different postings is not boilerplate", () => {
  // Two postings coincidentally sharing one short sentence, well under the
  // 50% ratio for a 12-posting board — not a template, left alone.
  const postings = boardOf(
    12,
    (city) =>
      city === "Chicago" || city === "Boston"
        ? "We use rust for the backend."
        : `A role in ${city}.`,
  );
  const { removedSegments } = stripBoilerplate(postings);
  // Only the always-present LEGAL_PARAGRAPH clears the ratio; the
  // coincidentally-shared "rust" sentence (2 of 12) does not.
  const legalOnly = stripBoilerplate(boardOf(12, (city) => `A role in ${city}.`));
  assertEquals(removedSegments, legalOnly.removedSegments);
});

/* ------------------------------------------------ writing prompts (M12) --- */

Deno.test("a document sharing zero terms with the profile is uncovered", () => {
  const facts = [fact("f1", "Built the data ingest pipeline at Acme.")];
  const uncovered = findUncoveredDocuments(facts, ["Ran a Kubernetes fleet in production."]);
  assertEquals(uncovered, [{ id: "f1", label: "Built the data ingest pipeline at Acme." }]);
});

Deno.test("a single shared word is not enough to count as coverage", () => {
  const facts = [fact("f1", "Built the data ingest pipeline at Acme.")];
  // Shares the bare words "built" and "pipeline", but no shared phrase — still uncovered.
  const uncovered = findUncoveredDocuments(facts, [
    "Built a monitoring pipeline for a mobile app.",
  ]);
  assertEquals(uncovered, [{ id: "f1", label: "Built the data ingest pipeline at Acme." }]);
});

Deno.test("a shared phrase counts as coverage, on an unrelated topic — blunt, not fuzzy", () => {
  const facts = [fact("f1", "Built the data ingest pipeline at Acme.")];
  // Shares the phrase "data ingest" with an otherwise unrelated fact — still covered.
  assertEquals(findUncoveredDocuments(facts, ["Built a data ingest tool for reporting."]), []);
});

Deno.test("an empty profile leaves every non-empty fact uncovered", () => {
  const facts = [fact("f1", "Ran a Postgres fleet."), fact("f2", "Wrote a CLI tool.")];
  assertEquals(findUncoveredDocuments(facts, [""]).length, 2);
});

Deno.test("a fact with no content words (after stopwords) is not a candidate either way", () => {
  const facts = [fact("f1", "and the of")]; // pure stopwords, tokenizes to nothing
  assertEquals(findUncoveredDocuments(facts, [""]), []);
});

Deno.test("a word common across most of the profile's own facets is not coverage", () => {
  const facts = [fact("f1", "Migrated the billing database to Postgres.")];
  // "built" and "using" recur in all three sections below — the profile's
  // own habits of phrase, not evidence that any of them addresses this fact.
  const facetSections = [
    "I built a lot of internal tools using modern practices.",
    "I built dashboards for the team using React.",
    "I built CI pipelines using GitHub Actions.",
  ];
  assertEquals(findUncoveredDocuments(facts, facetSections), [
    { id: "f1", label: "Migrated the billing database to Postgres." },
  ]);
});

Deno.test("a distinctive phrase shared with even one facet still counts as coverage", () => {
  const facts = [fact("f1", "Migrated the billing database to Postgres.")];
  const facetSections = [
    "I handle billing database migrations across the fleet.",
    "I built dashboards for the team using React.",
    "I built CI pipelines using GitHub Actions.",
  ];
  assertEquals(findUncoveredDocuments(facts, facetSections), []);
});

Deno.test("fewer than three sections is too few to call anything generic", () => {
  // "small migration" recurs in both sections, but with only two there is no
  // "most of them" to speak of — coincidence, not a habit — so it still counts.
  const facts = [fact("f1", "Built a small migration script.")];
  const facetSections = [
    "I built a lot of small migration tools.",
    "I built dashboards using small migration scripts for the team.",
  ];
  assertEquals(findUncoveredDocuments(facts, facetSections), []);
});

Deno.test("a broad facet sharing only single words with an unrelated fact does not cover it (#28)", () => {
  // Production case: a facet named "Payroll" and a fact about an unrelated
  // reporting dashboard used to be "covered" by sharing bare, ordinary nouns
  // like "system" alone — with no phrase in common, it no longer is.
  const facts = [
    fact(
      "f1",
      "Toyota ACV Reporting Dashboard — read-only reporting on closed deals across internal tables.",
    ),
  ];
  const facetSections = [
    "Payroll: encode California payroll law into the system logic that runs payroll.",
  ];
  const uncovered = findUncoveredDocuments(facts, facetSections);
  assertEquals(uncovered.length, 1);
});

Deno.test("matching is case- and inflection-blind only where it honestly can be", () => {
  const postings = [posting("1", "Alpha", "Kubernetes"), posting("2", "Beta", "KUBERNETES")];
  const report = findVocabularyGaps(postings, "kubernetes", "kubernetes", { minPostings: 2 });
  assertEquals(report.gaps.map((g) => g.term).includes("kubernetes"), false, "case is not a gap");

  // Plurals are a different token and this module does not stem. Better to
  // over-report a term the reader can dismiss than to silently merge two words.
  const plural = findVocabularyGaps(
    [posting("1", "Alpha", "microservices"), posting("2", "Beta", "microservices")],
    "microservice",
    "microservice",
    { minPostings: 2 },
  );
  assertEquals(plural.gaps[0]?.term, "microservices");
});
