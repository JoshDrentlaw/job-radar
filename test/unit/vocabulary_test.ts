import { assert, assertEquals } from "@std/assert";
import {
  findUncoveredDocuments,
  findVocabularyGaps,
  gapKind,
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

/* ------------------------------------------------ writing prompts (M12) --- */

Deno.test("a document sharing zero terms with the profile is uncovered", () => {
  const facts = [fact("f1", "Built the data ingest pipeline at Acme.")];
  const uncovered = findUncoveredDocuments(facts, "Ran a Kubernetes fleet in production.");
  assertEquals(uncovered, [{ id: "f1", label: "Built the data ingest pipeline at Acme." }]);
});

Deno.test("even one shared word counts as coverage — blunt, not fuzzy", () => {
  const facts = [fact("f1", "Built the data ingest pipeline at Acme.")];
  // Shares only "built" with the profile, on an unrelated topic — still covered.
  assertEquals(findUncoveredDocuments(facts, "Built a mobile app in Swift."), []);
});

Deno.test("an empty profile leaves every non-empty fact uncovered", () => {
  const facts = [fact("f1", "Ran a Postgres fleet."), fact("f2", "Wrote a CLI tool.")];
  assertEquals(findUncoveredDocuments(facts, "").length, 2);
});

Deno.test("a fact with no content words (after stopwords) is not a candidate either way", () => {
  const facts = [fact("f1", "and the of")]; // pure stopwords, tokenizes to nothing
  assertEquals(findUncoveredDocuments(facts, ""), []);
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
