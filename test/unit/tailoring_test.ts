import { assert, assertEquals, assertThrows } from "@std/assert";
import type { FactId, PostingId } from "@platform/ids.ts";
import type { ResumeFact } from "@domain/dossier/types.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "@domain/llm.ts";
import {
  buildTailoringRequest,
  FabricationError,
  MalformedProposalError,
  parseTailoringResponse,
  proposeTailoring,
  REWRITE_SCHEMA,
} from "@domain/dossier/tailoring.ts";
import { COVER_LETTER_SCHEMA, parseCoverLetterResponse } from "@domain/dossier/cover-letter.ts";

function fact(id: string, text: string, kind: ResumeFact["kind"] = "bullet"): ResumeFact {
  return {
    id: id as FactId,
    kind,
    text,
    tags: [],
    active: true,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const FACTS: ResumeFact[] = [
  fact("f-1", "Built the data ingest pipeline."),
  fact("f-2", "Ran the Postgres fleet."),
  fact("f-3", "Wrote long-form notes about operating databases under load.", "narrative"),
];

const TARGET = {
  postingId: "greenhouse:acme:1" as PostingId,
  title: "Backend Engineer",
  companyName: "Acme",
  descriptionText: "We need someone who has built ingest pipelines.",
};

/* ------------------------------------------------ the fabrication rule ---- */

Deno.test("rule 3: an unknown factId rejects the whole response", () => {
  const json = {
    rewrites: [
      { factId: "f-1", rewrittenText: "Designed the ingest pipeline.", rationale: "ok" },
      { factId: "f-ghost", rewrittenText: "Led the platform team.", rationale: "invented" },
    ],
  };
  const error = assertThrows(
    () => parseTailoringResponse(json, FACTS),
    FabricationError,
  ) as FabricationError;
  // Not silently dropped: the good row goes down with the bad one.
  assertEquals(error.unknownIds, ["f-ghost"]);
  assert(error.message.includes("entire response was rejected"));
});

Deno.test("rule 3: every unknown id is named, not just the first", () => {
  const json = {
    rewrites: [
      { factId: "nope-1", rewrittenText: "x", rationale: "" },
      { factId: "f-1", rewrittenText: "y", rationale: "" },
      { factId: "nope-2", rewrittenText: "z", rationale: "" },
    ],
  };
  const error = assertThrows(
    () => parseTailoringResponse(json, FACTS),
    FabricationError,
  ) as FabricationError;
  assertEquals(error.unknownIds, ["nope-1", "nope-2"]);
});

Deno.test("valid rewrites parse, carrying source text and a drift report", () => {
  const json = {
    rewrites: [{
      factId: "f-1",
      rewrittenText: "Built the data ingest pipeline end to end.",
      rationale: "matches the posting's wording",
    }],
  };
  const proposals = parseTailoringResponse(json, FACTS);
  assertEquals(proposals.length, 1);
  assertEquals(proposals[0]!.factId, "f-1" as FactId);
  assertEquals(proposals[0]!.sourceText, "Built the data ingest pipeline.");
  assertEquals(proposals[0]!.drift.flagged, false);
});

Deno.test("a rewrite identical to its source is dropped as noise", () => {
  const json = {
    rewrites: [{ factId: "f-1", rewrittenText: "Built the data ingest pipeline.", rationale: "" }],
  };
  assertEquals(parseTailoringResponse(json, FACTS), []);
});

Deno.test("malformed responses are rejected, not coerced", () => {
  assertThrows(() => parseTailoringResponse({}, FACTS), MalformedProposalError);
  assertThrows(() => parseTailoringResponse({ rewrites: "no" }, FACTS), MalformedProposalError);
  assertThrows(
    () => parseTailoringResponse({ rewrites: [{ rewrittenText: "x" }] }, FACTS),
    MalformedProposalError,
  );
  assertThrows(
    () => parseTailoringResponse({ rewrites: [{ factId: "f-1", rewrittenText: "  " }] }, FACTS),
    MalformedProposalError,
  );
});

/* ------------------------------------------------ prompt construction ----- */

Deno.test("the fact corpus is the cacheable prefix; the posting is not", () => {
  const request = buildTailoringRequest(FACTS, TARGET);
  assert(request.cacheablePrefix !== undefined);
  // Every id the model may cite is in the cached half...
  for (const f of FACTS) assert(request.cacheablePrefix!.includes(f.id));
  // ...and the volatile posting is in messages, after the cache breakpoint.
  assert(!request.cacheablePrefix!.includes("Acme"));
  assert(request.messages[0]!.content.includes("Acme"));
  assertEquals(request.schema, REWRITE_SCHEMA);
});

Deno.test("the schema forbids extra fields at every level", () => {
  assertEquals(REWRITE_SCHEMA.additionalProperties, false);
  const properties = REWRITE_SCHEMA.properties as {
    rewrites: { items: Record<string, unknown> };
  };
  const items = properties.rewrites.items;
  assertEquals(items.additionalProperties, false);
  assertEquals(items.required, ["factId", "rewrittenText", "rationale"]);
  assertEquals(COVER_LETTER_SCHEMA.additionalProperties, false);
});

/* ------------------------------------------------ the use-case ------------ */

class FakeLlm implements LlmClient {
  readonly model = "fake-model";
  lastRequest: LlmRequest | undefined;
  constructor(private readonly json: unknown) {}
  complete(request: LlmRequest): Promise<LlmResponse> {
    this.lastRequest = request;
    return Promise.resolve({
      json: this.json,
      model: this.model,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 0,
      },
    });
  }
}

Deno.test("proposeTailoring sends only active facts and returns proposals", async () => {
  const retired = [...FACTS, { ...fact("f-old", "An old claim."), active: false }];
  const llm = new FakeLlm({
    rewrites: [{ factId: "f-2", rewrittenText: "Operated the Postgres fleet.", rationale: "r" }],
  });

  const result = await proposeTailoring(llm, retired, TARGET);
  assertEquals(result.factCount, 3);
  assertEquals(result.proposals.length, 1);
  assertEquals(result.model, "fake-model");
  assert(!llm.lastRequest!.cacheablePrefix!.includes("An old claim."));
});

Deno.test("a rewrite of a retired fact is fabrication — it was not in the set sent", async () => {
  const facts = [...FACTS, { ...fact("f-old", "An old claim."), active: false }];
  const llm = new FakeLlm({
    rewrites: [{ factId: "f-old", rewrittenText: "A polished old claim.", rationale: "" }],
  });
  const error = await proposeTailoring(llm, facts, TARGET).catch((e: unknown) => e);
  assert(error instanceof FabricationError);
});

Deno.test("proposeTailoring refuses when there is nothing to tailor", async () => {
  const llm = new FakeLlm({ rewrites: [] });
  const error = await proposeTailoring(llm, [], TARGET).catch((e: unknown) => e);
  assert(error instanceof MalformedProposalError);
});

/* ------------------------------------------------ cover letters ----------- */

Deno.test("cover letter: an unknown citation rejects the whole letter", () => {
  const json = {
    paragraphs: [
      { text: "A true paragraph.", citedFactIds: ["f-1"], rationale: "" },
      { text: "An invented one.", citedFactIds: ["f-nope"], rationale: "" },
    ],
  };
  assertThrows(() => parseCoverLetterResponse(json, FACTS), FabricationError);
});

Deno.test("cover letter: a paragraph citing nothing is rejected", () => {
  const json = { paragraphs: [{ text: "Unsupported claim.", citedFactIds: [], rationale: "" }] };
  assertThrows(() => parseCoverLetterResponse(json, FACTS), MalformedProposalError);
});

Deno.test("cover letter: valid paragraphs parse with deduplicated citations", () => {
  const json = {
    paragraphs: [{
      text: "Built pipelines and ran databases.",
      citedFactIds: ["f-1", "f-2", "f-1"],
      rationale: "covers both requirements",
    }],
  };
  const paragraphs = parseCoverLetterResponse(json, FACTS);
  assertEquals(paragraphs.length, 1);
  assertEquals(paragraphs[0]!.citedFactIds, ["f-1", "f-2"] as FactId[]);
});

Deno.test("cover letter: narrative facts are available to cite", () => {
  const json = {
    paragraphs: [{ text: "On operating databases.", citedFactIds: ["f-3"], rationale: "" }],
  };
  assertEquals(parseCoverLetterResponse(json, FACTS).length, 1);
});
