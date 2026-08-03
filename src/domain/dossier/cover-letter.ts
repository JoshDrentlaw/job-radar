/**
 * Cover letters (§8, M5).
 *
 * "Cover letters follow the same rule: generated from facts, every claim
 * traceable, reviewed before use."
 *
 * Traceability is structural here rather than promised: the model returns
 * paragraphs, each carrying the ids of the facts it rests on, and a paragraph
 * citing an id that does not exist rejects the whole letter — the same
 * all-or-nothing rule tailoring uses. The review UI then shows each paragraph
 * beside the facts it claims to be built from, so "traceable" is something the
 * user can actually check rather than take on faith.
 *
 * This is where the narrative fact kind earns its place: resume bullets are
 * clipped and metric-shaped, and a letter built only from them reads like a
 * resume in prose. Narrative facts are longer-form true statements written for
 * exactly this, and they carry the same guarantee as every other fact.
 */

import type { FactId, PostingId } from "@platform/ids.ts";
import type { LlmClient, LlmRequest, LlmUsage } from "@domain/llm.ts";
import { FabricationError, MalformedProposalError, renderFactCorpus } from "./tailoring.ts";
import type { Identity, ResumeFact } from "./types.ts";

export const COVER_LETTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          citedFactIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: ["text", "citedFactIds", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["paragraphs"],
  additionalProperties: false,
};

export interface DraftParagraph {
  readonly text: string;
  readonly rationale: string;
  readonly citedFactIds: readonly FactId[];
}

const SYSTEM = `You draft cover letter paragraphs from a fixed set of true facts.

Every claim you make must rest on a fact you were given, and you must cite the
ids of the facts each paragraph rests on. Those citations are shown to the user
next to your paragraph so they can check your work — a citation that does not
support the sentence it is attached to is worse than no paragraph at all.

Rules:
- Never state anything the facts do not support: no invented metrics, employers,
  dates, technologies, motivations, or opinions about the company.
- Do not claim enthusiasm, admiration, or knowledge of the company. You have no
  facts about how the writer feels, so you cannot write it. The user will add
  that themselves if they want it.
- Every paragraph must cite at least one fact id, and may only cite ids from the
  provided fact set.
- Write plainly. No "I am writing to express my interest", no "I am confident
  that", no restating the job title back at the reader.
- Three or four paragraphs is right for a cover letter. Prefer fewer, denser
  paragraphs over more thin ones.
- The rationale explains, in one sentence, why this paragraph belongs.

Output only the required JSON.`;

export interface CoverLetterTarget {
  readonly postingId: PostingId;
  readonly title: string;
  readonly companyName: string;
  readonly descriptionText: string;
}

export function buildCoverLetterRequest(
  facts: readonly ResumeFact[],
  target: CoverLetterTarget,
  identity: Identity | null,
): LlmRequest {
  const who = identity === null ? "" : `The writer is ${identity.name}.\n\n`;
  return {
    system: SYSTEM,
    cacheablePrefix: renderFactCorpus(facts),
    messages: [{
      role: "user",
      content: `${who}Target posting — ${target.title} at ${target.companyName}.\n\n` +
        `${target.descriptionText}\n\n` +
        `Draft the body paragraphs of a cover letter for this posting, citing the ` +
        `facts each paragraph rests on.`,
    }],
    schema: COVER_LETTER_SCHEMA,
  };
}

interface RawParagraph {
  text?: unknown;
  citedFactIds?: unknown;
  rationale?: unknown;
}

/** Same all-or-nothing rejection as tailoring: an unknown citation voids the letter. */
export function parseCoverLetterResponse(
  json: unknown,
  facts: readonly ResumeFact[],
): DraftParagraph[] {
  const paragraphs = (json as { paragraphs?: unknown })?.paragraphs;
  if (!Array.isArray(paragraphs)) {
    throw new MalformedProposalError("The response has no `paragraphs` array.");
  }

  const known = new Set(facts.map((fact) => fact.id as string));
  const unknown: string[] = [];
  for (const row of paragraphs as RawParagraph[]) {
    if (!Array.isArray(row?.citedFactIds)) {
      throw new MalformedProposalError("A paragraph is missing its citedFactIds.");
    }
    for (const id of row.citedFactIds) {
      if (typeof id !== "string") {
        throw new MalformedProposalError("A citation is not a string id.");
      }
      if (!known.has(id)) unknown.push(id);
    }
  }
  if (unknown.length > 0) throw new FabricationError(unknown);

  const drafted: DraftParagraph[] = [];
  for (const row of paragraphs as RawParagraph[]) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text === "") throw new MalformedProposalError("A paragraph has empty text.");
    const cited = [...new Set(row.citedFactIds as string[])] as FactId[];
    // A paragraph resting on nothing is exactly what the citation rule exists
    // to prevent; it is a claim with no traceable source.
    if (cited.length === 0) {
      throw new MalformedProposalError(
        `A paragraph cites no facts: ${JSON.stringify(text.slice(0, 60))}`,
      );
    }
    drafted.push({
      text,
      citedFactIds: cited,
      rationale: typeof row.rationale === "string" ? row.rationale.trim() : "",
    });
  }
  if (drafted.length === 0) {
    throw new MalformedProposalError("The response contains no paragraphs.");
  }
  return drafted;
}

export interface CoverLetterResult {
  readonly paragraphs: readonly DraftParagraph[];
  readonly model: string;
  readonly usage: LlmUsage;
}

export async function proposeCoverLetter(
  llm: LlmClient,
  facts: readonly ResumeFact[],
  target: CoverLetterTarget,
  identity: Identity | null,
): Promise<CoverLetterResult> {
  const active = facts.filter((fact) => fact.active);
  if (active.length === 0) {
    throw new MalformedProposalError("There are no active facts to draft from.");
  }
  const response = await llm.complete(buildCoverLetterRequest(active, target, identity));
  return {
    paragraphs: parseCoverLetterResponse(response.json, active),
    model: response.model,
    usage: response.usage,
  };
}
