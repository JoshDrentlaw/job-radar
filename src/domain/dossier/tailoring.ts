/**
 * Tailoring (§8, M5).
 *
 * "Tailoring is reordering, selecting, and rewording facts that already exist.
 * It is not generating experience."
 *
 * The five structural rules from the brief, and where each lives:
 *
 *  1. The call receives the fact set (cached) and the target posting — `buildTailoringRequest`.
 *  2. It must return `{factId, rewrittenText, rationale}[]` and nothing else — `REWRITE_SCHEMA`.
 *  3. **An unknown factId rejects the whole response** — `parseTailoringResponse`.
 *  4. A similarity check flags drift for review — `drift.ts`, applied here.
 *  5. Nothing enters a variant unreviewed — enforced by the proposal table and
 *     the review UI; this module only ever produces *proposals*.
 *
 * Rule 3 is the load-bearing one and is deliberately harsh: dropping the bad
 * row and keeping the rest would mean accepting output from a model that just
 * demonstrated it was not working from the given fact set.
 */

import type { FactId, PostingId } from "@platform/ids.ts";
import type { LlmClient, LlmRequest } from "@domain/llm.ts";
import { checkDrift, type DriftReport } from "./drift.ts";
import type { ResumeFact } from "./types.ts";

export class FabricationError extends Error {
  override readonly name = "FabricationError";
  readonly unknownIds: readonly string[];
  constructor(unknownIds: readonly string[]) {
    super(
      `The model cited ${unknownIds.length} fact id(s) that do not exist in the fact set: ` +
        `${unknownIds.join(", ")}. The entire response was rejected — a response that ` +
        `invents identifiers is not working from the facts it was given.`,
    );
    this.unknownIds = unknownIds;
  }
}

export class MalformedProposalError extends Error {
  override readonly name = "MalformedProposalError";
}

/**
 * Rule 2, structurally. `additionalProperties: false` everywhere: the model may
 * return these fields and nothing else.
 *
 * `factId` is a plain string rather than an enum of the valid ids. An enum
 * would make fabrication impossible at the schema level, but the schema would
 * then change on every call — losing the compiled-schema cache — and rule 3
 * requires the runtime rejection regardless. The check below is the guarantee.
 */
export const REWRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rewrites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          factId: { type: "string" },
          rewrittenText: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["factId", "rewrittenText", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["rewrites"],
  additionalProperties: false,
};

export interface RewriteProposal {
  readonly factId: FactId;
  readonly sourceText: string;
  readonly proposedText: string;
  readonly rationale: string;
  readonly drift: DriftReport;
}

const SYSTEM = `You reword existing resume facts to suit a specific job posting.

You are working inside a system with a hard constraint: every statement you
produce must be a rewording of a fact you were given. You are not writing a
resume and you are not describing a candidate — you are rephrasing supplied
sentences so a recruiter searching for this role's vocabulary will find them.

Rules:
- Only reword facts from the provided fact set. Reference each by its exact id.
- Never introduce a metric, number, date, employer, technology, or achievement
  that is not already present in the fact you are rewording. If a posting asks
  for something the facts do not support, say nothing about it — its absence is
  useful information for the user.
- You may adopt the posting's vocabulary where it genuinely names the same
  thing the fact already describes (a fact saying "TS" may be reworded to
  "TypeScript"). You may not adopt vocabulary for work that was not done.
- Reword only where it helps. Returning fewer rewrites than facts is correct
  and expected; a fact that already reads well for this posting should be left
  alone rather than churned.
- The rationale explains, in one sentence, why this wording suits this posting.

Output only the required JSON.`;

function renderFact(fact: ResumeFact): string {
  const parts = [`id: ${fact.id}`, `kind: ${fact.kind}`];
  if (fact.organization !== undefined) parts.push(`organization: ${fact.organization}`);
  if (fact.tags.length > 0) parts.push(`tags: ${fact.tags.join(", ")}`);
  return `${parts.join(" | ")}\ntext: ${fact.text}`;
}

/** The stable half of the prompt: the fact corpus, worth caching (§3). */
export function renderFactCorpus(facts: readonly ResumeFact[]): string {
  return `The complete fact set. Every id you may cite appears here.\n\n` +
    facts.map(renderFact).join("\n\n");
}

export interface TailoringTarget {
  readonly postingId: PostingId;
  readonly title: string;
  readonly companyName: string;
  readonly descriptionText: string;
}

/** Rule 1: fact set (cacheable) plus the target posting (volatile). */
export function buildTailoringRequest(
  facts: readonly ResumeFact[],
  target: TailoringTarget,
): LlmRequest {
  return {
    system: SYSTEM,
    cacheablePrefix: renderFactCorpus(facts),
    messages: [{
      role: "user",
      content: `Target posting — ${target.title} at ${target.companyName}.\n\n` +
        `${target.descriptionText}\n\n` +
        `Reword the facts that would land better with this posting's vocabulary. ` +
        `Leave the rest alone.`,
    }],
    schema: REWRITE_SCHEMA,
  };
}

interface RawRewrite {
  factId?: unknown;
  rewrittenText?: unknown;
  rationale?: unknown;
}

/**
 * Rules 3 and 4. Unknown ids reject the whole response; surviving rows get a
 * drift report so the reviewer knows where to look first.
 */
export function parseTailoringResponse(
  json: unknown,
  facts: readonly ResumeFact[],
): RewriteProposal[] {
  const rewrites = (json as { rewrites?: unknown })?.rewrites;
  if (!Array.isArray(rewrites)) {
    throw new MalformedProposalError("The response has no `rewrites` array.");
  }

  const byId = new Map(facts.map((fact) => [fact.id as string, fact]));

  // Collect every unknown id before throwing, so the error names all of them.
  const unknown: string[] = [];
  for (const row of rewrites as RawRewrite[]) {
    if (typeof row?.factId !== "string") {
      throw new MalformedProposalError("A rewrite is missing its factId.");
    }
    if (!byId.has(row.factId)) unknown.push(row.factId);
  }
  if (unknown.length > 0) throw new FabricationError(unknown);

  const seen = new Set<string>();
  const proposals: RewriteProposal[] = [];
  for (const row of rewrites as RawRewrite[]) {
    const factId = row.factId as string;
    if (seen.has(factId)) continue; // one proposal per fact; first wins
    seen.add(factId);

    const proposedText = typeof row.rewrittenText === "string" ? row.rewrittenText.trim() : "";
    const rationale = typeof row.rationale === "string" ? row.rationale.trim() : "";
    if (proposedText === "") {
      throw new MalformedProposalError(`Rewrite for ${factId} has empty text.`);
    }

    const fact = byId.get(factId)!;
    // An unchanged "rewrite" is noise in the review queue.
    if (proposedText === fact.text) continue;

    proposals.push({
      factId: fact.id,
      sourceText: fact.text,
      proposedText,
      rationale,
      drift: checkDrift(fact.text, proposedText),
    });
  }
  return proposals;
}

export interface TailoringResult {
  readonly proposals: readonly RewriteProposal[];
  readonly model: string;
  readonly usage: import("@domain/llm.ts").LlmUsage;
  readonly factCount: number;
}

/**
 * Propose rewrites for one posting. Produces proposals only — nothing here
 * touches a variant, because nothing enters a variant unreviewed (§8 rule 5).
 */
export async function proposeTailoring(
  llm: LlmClient,
  facts: readonly ResumeFact[],
  target: TailoringTarget,
): Promise<TailoringResult> {
  const active = facts.filter((fact) => fact.active);
  if (active.length === 0) {
    throw new MalformedProposalError("There are no active facts to tailor.");
  }
  const response = await llm.complete(buildTailoringRequest(active, target));
  return {
    proposals: parseTailoringResponse(response.json, active),
    model: response.model,
    usage: response.usage,
    factCount: active.length,
  };
}
