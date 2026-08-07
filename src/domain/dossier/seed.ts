/**
 * Seeding the dossier from a pasted resume (M11).
 *
 * The fact set's own rule holds here too: no model writes to `dossier.facts`.
 * This module only ever produces *candidates* — parsed, validated, and handed
 * back to the route as plain data. Every candidate is rendered pre-filled into
 * the same fields a hand-typed fact uses, and only an explicit "Add these
 * facts" submission — a human clicking, same as accepting a tailoring
 * proposal — reaches `FactRepo.create`. Nothing here touches a repository.
 *
 * Unlike tailoring, there is no existing fact set to check citations against —
 * the source is whatever the user pasted, and the “is this true” judgment is
 * the review step, not a schema constraint. So the discipline that matters
 * here is upstream, in the prompt: extract close to the source, don't
 * embellish, and leave out anything the resume doesn't actually say.
 */

import type { LlmRequest } from "@domain/llm.ts";
import { FACT_KINDS, type FactInput, type FactKind, isFactKind, PARENT_KINDS } from "./types.ts";

export class MalformedSeedError extends Error {
  override readonly name = "MalformedSeedError";
}

/**
 * `parentIndex` refers to another entry's `index` in the same response — the
 * only way a bullet can point at "the role three items up" when neither has a
 * real id yet. Both id-like fields are plain integers rather than strings for
 * the same reason `factId` in tailoring is a plain string: constraining the
 * schema to only-ever-valid values would fight the compiled-schema cache for
 * no real gain, since the range check below is required regardless.
 */
export const SEED_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    identity: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        links: { type: "array", items: { type: "string" } },
      },
      required: ["name", "email", "phone", "location", "links"],
      additionalProperties: false,
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          kind: { type: "string", enum: [...FACT_KINDS] },
          parentIndex: { type: ["integer", "null"] },
          text: { type: "string" },
          organization: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
        },
        required: [
          "index",
          "kind",
          "parentIndex",
          "text",
          "organization",
          "tags",
          "startDate",
          "endDate",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["identity", "facts"],
  additionalProperties: false,
};

const SYSTEM = `You turn a pasted resume into structured facts for a fact-based resume builder.

Every fact you produce must be traceable to text actually present in the resume you were given.
You are transcribing and organizing, not writing a resume — closer to filling out a form from a
document than composing one.

Rules:
- Extract summary lines, roles (with organization and dates), bullets under each role, skills,
  education, and projects. Skip section headers and anything that is formatting, not content.
- A bullet's "parentIndex" must be the index of the role or project it belongs to, from this same
  response. A skill, summary, or education entry has no parent — leave parentIndex null.
- Dates are "YYYY-MM" or null. Never guess a date the resume does not state; a role's dates
  showing only a year should use "-01" for the missing month rather than inventing one, and a
  vague range ("2019 - present") should leave endDate null.
- Never invent an employer, title, metric, or duration that is not in the source text. If the
  resume is ambiguous, extract it as written rather than resolving the ambiguity yourself.
- Reword only to turn a raw resume line into a standalone statement (dropping a leading bullet
  glyph, expanding "Sr." to "Senior" is fine); do not add claims, and do not embellish.
- Extract identity fields (name, email, phone, location, links such as a portfolio or LinkedIn
  URL) only where the resume actually states them; leave the rest null.

Output only the required JSON.`;

export function buildSeedRequest(resumeText: string): LlmRequest {
  return {
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `The resume, verbatim:\n\n${resumeText}`,
    }],
    schema: SEED_SCHEMA,
    // A full resume plus one candidate fact per line comfortably exceeds the
    // client's default; a long CV should not truncate mid-response.
    maxTokens: 16_000,
  };
}

export interface SeedIdentity {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly location?: string;
  readonly links: readonly string[];
}

/** A candidate fact, not yet created. `parentIndex` is resolved to `parentOf` below. */
export interface SeedFact extends FactInput {
  readonly index: number;
  /** Always populated below, unlike the inherited optional. */
  readonly tags: readonly string[];
  /** The `index` of this fact's parent among the other candidates, if any. */
  readonly parentOf?: number;
}

export interface SeedResult {
  readonly identity: SeedIdentity | null;
  readonly facts: readonly SeedFact[];
}

interface RawIdentity {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  location?: unknown;
  links?: unknown;
}

interface RawFact {
  index?: unknown;
  kind?: unknown;
  parentIndex?: unknown;
  text?: unknown;
  organization?: unknown;
  tags?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** "2019-06" → a UTC first-of-month Date, or undefined for anything else. */
function parseMonth(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseIdentity(raw: unknown): SeedIdentity | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as RawIdentity;
  const links = Array.isArray(r.links)
    ? r.links.filter((l): l is string => typeof l === "string" && l.trim() !== "")
    : [];
  const name = nonEmptyString(r.name);
  const email = nonEmptyString(r.email);
  const phone = nonEmptyString(r.phone);
  const location = nonEmptyString(r.location);
  const hasAnything = name !== undefined || email !== undefined || phone !== undefined ||
    location !== undefined || links.length > 0;
  if (!hasAnything) return null;
  return {
    links,
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(location !== undefined ? { location } : {}),
  };
}

/**
 * Validates shape and resolves `parentIndex` references. A bullet whose
 * parent isn't a role/project in this same response loses the parent link
 * rather than rejecting the whole extraction — a resume with one bad
 * cross-reference among forty facts should not discard the other thirty-nine;
 * the review step is exactly where a human catches the orphan.
 */
export function parseSeedResponse(json: unknown): SeedResult {
  const body = json as { identity?: unknown; facts?: unknown };
  if (!Array.isArray(body?.facts)) {
    throw new MalformedSeedError("The response has no `facts` array.");
  }

  const raw = body.facts as RawFact[];
  const kindByIndex = new Map<number, FactKind>();
  for (const row of raw) {
    if (typeof row?.index !== "number" || typeof row?.kind !== "string") continue;
    if (isFactKind(row.kind)) kindByIndex.set(row.index, row.kind);
  }

  const facts: SeedFact[] = [];
  for (const row of raw) {
    if (typeof row.index !== "number") {
      throw new MalformedSeedError("A candidate fact is missing its index.");
    }
    if (typeof row.kind !== "string" || !isFactKind(row.kind)) {
      throw new MalformedSeedError(`Candidate ${row.index} has an unknown kind.`);
    }
    const text = nonEmptyString(row.text);
    if (text === undefined) continue; // an empty extraction is noise, not a candidate

    const parentIndex = typeof row.parentIndex === "number" ? row.parentIndex : undefined;
    const parentKind = parentIndex !== undefined ? kindByIndex.get(parentIndex) : undefined;
    const parentOf = parentKind !== undefined && PARENT_KINDS.has(parentKind)
      ? parentIndex
      : undefined;

    const tags = Array.isArray(row.tags)
      ? [
        ...new Set(
          row.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
            .map((t) => t.trim().toLowerCase()),
        ),
      ]
      : [];

    const organization = nonEmptyString(row.organization);
    const startDate = parseMonth(row.startDate);
    const endDate = parseMonth(row.endDate);
    facts.push({
      index: row.index,
      kind: row.kind,
      text,
      tags,
      ...(organization !== undefined ? { organization } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(parentOf !== undefined ? { parentOf } : {}),
    });
  }

  return { identity: parseIdentity(body.identity), facts };
}
