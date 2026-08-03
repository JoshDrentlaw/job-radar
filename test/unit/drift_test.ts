import { assert, assertEquals } from "@std/assert";
import { checkDrift, SIMILARITY_THRESHOLD } from "@domain/dossier/drift.ts";

Deno.test("an honest reword keeps its meaning and is not flagged", () => {
  const report = checkDrift(
    "Built the data ingest pipeline.",
    "Built and maintained the data ingest pipeline.",
  );
  assert(report.similarity >= SIMILARITY_THRESHOLD, `similarity ${report.similarity}`);
  assertEquals(report.novelTerms, []);
  assertEquals(report.flagged, false);
});

Deno.test("an invented metric is caught even when the sentence is otherwise faithful", () => {
  // This is the dangerous case: high semantic similarity, fabricated specific.
  const report = checkDrift(
    "Built the data ingest pipeline.",
    "Built the data ingest pipeline, cutting latency by 40%.",
  );
  assert(report.novelTerms.includes("40%"), report.novelTerms.join(","));
  assertEquals(report.flagged, true);
});

Deno.test("an invented technology is caught", () => {
  const report = checkDrift(
    "Ran the database fleet.",
    "Ran the database fleet on Kubernetes.",
  );
  assert(report.novelTerms.includes("Kubernetes"));
  assertEquals(report.flagged, true);
});

Deno.test("a number already in the source is not novel", () => {
  const report = checkDrift(
    "Ran a fleet of 12 Postgres instances.",
    "Operated 12 Postgres instances in production.",
  );
  assert(!report.novelTerms.includes("12"), report.novelTerms.join(","));
});

Deno.test("a proper noun already in the source is not novel", () => {
  const report = checkDrift(
    "Ran the Postgres fleet.",
    "Operated the Postgres fleet day to day.",
  );
  assertEquals(report.novelTerms, []);
});

Deno.test("a sentence-initial capital is not treated as a proper noun", () => {
  const report = checkDrift("built the pipeline", "Built the pipeline");
  assertEquals(report.novelTerms, []);
});

Deno.test("a wholesale rewrite drops below the similarity threshold", () => {
  const report = checkDrift(
    "Built the data ingest pipeline.",
    "Led hiring and mentoring across the engineering organisation.",
  );
  assert(report.similarity < SIMILARITY_THRESHOLD, `similarity ${report.similarity}`);
  assertEquals(report.flagged, true);
});

Deno.test("similarity measures what survives, not what is added", () => {
  // Adding context keeps every original word: not drift by this measure.
  const kept = checkDrift("Ran the fleet.", "Ran the fleet across three regions.");
  assertEquals(kept.similarity, 1);
  // Dropping the substance is.
  const lost = checkDrift("Ran the Postgres fleet nightly.", "Did operations work.");
  assert(lost.similarity < 0.3, `similarity ${lost.similarity}`);
});

Deno.test("identical text is maximally similar", () => {
  const report = checkDrift("Built the pipeline.", "Built the pipeline.");
  assertEquals(report.similarity, 1);
  assertEquals(report.flagged, false);
});
