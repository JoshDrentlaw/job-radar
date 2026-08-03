/**
 * Variant → renderable resume (§8).
 *
 * Pure assembly: identity + fact set + variant in, an intermediate
 * representation out. Both renderers (PDF, DOCX) consume this IR and nothing
 * else, which is what keeps the renderer separate from the model — and keeps
 * "same variant, same bytes" achievable, because the IR is a deterministic
 * function of its inputs.
 */

import type { FactId } from "@platform/ids.ts";
import type { Identity, ResumeFact, ResumeVariant } from "./types.ts";

export interface ExperienceEntry {
  /** The role/project/education fact's text (possibly rewritten). */
  readonly title: string;
  readonly organization?: string;
  readonly dates?: string;
  readonly bullets: readonly string[];
}

export type ResumeSection =
  | { readonly kind: "summary"; readonly paragraphs: readonly string[] }
  | {
    readonly kind: "experience";
    readonly heading: string;
    readonly entries: readonly ExperienceEntry[];
  }
  | { readonly kind: "skills"; readonly items: readonly string[] };

export interface RenderableResume {
  readonly identity: Identity;
  readonly sections: readonly ResumeSection[];
}

export class ResumeAssemblyError extends Error {
  override readonly name = "ResumeAssemblyError";
}

/** Problems worth showing that do not prevent rendering. */
export interface AssemblyWarning {
  readonly factId: FactId;
  readonly reason: "bullet-without-parent" | "parent-not-selected" | "narrative-not-in-resume";
}

export interface AssembledResume {
  readonly resume: RenderableResume;
  readonly warnings: readonly AssemblyWarning[];
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** UTC, fixed vocabulary — display formatting must not depend on the host. */
export function formatDateRange(start?: Date, end?: Date): string | undefined {
  const fmt = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return `${fmt(start)} – ${fmt(end)}`;
  if (start !== undefined) return `${fmt(start)} – Present`;
  return fmt(end!);
}

/**
 * Assemble in the variant's own order. Sections appear in fixed order
 * (summary, experience, projects, education, skills); within a section the
 * variant's ordering is authoritative. Bullets render under their parent when
 * both are selected; a selected bullet whose parent is missing becomes a
 * warning, not silent loss.
 */
export function assembleResume(
  identity: Identity,
  facts: readonly ResumeFact[],
  variant: ResumeVariant,
): AssembledResume {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));

  const ordered = [...variant.entries].sort((a, b) => a.position - b.position);
  for (const entry of ordered) {
    if (!byId.has(entry.factId)) {
      // A cited fact must exist — RESTRICT guarantees it; its absence means
      // corruption, and rendering a resume missing a claimed fact would be
      // fabrication by omission.
      throw new ResumeAssemblyError(
        `Variant "${variant.name}" cites fact ${entry.factId}, which does not exist.`,
      );
    }
  }

  const textOf = (entry: { factId: FactId; rewrittenText?: string }): string => {
    const rewritten = entry.rewrittenText?.trim() ?? "";
    return rewritten !== "" ? rewritten : byId.get(entry.factId)!.text;
  };

  const warnings: AssemblyWarning[] = [];
  const selectedIds = new Set(ordered.map((e) => e.factId));

  // Bullets grouped under their selected parent, in variant order.
  const bulletsByParent = new Map<FactId, string[]>();
  for (const entry of ordered) {
    const fact = byId.get(entry.factId)!;
    if (fact.kind !== "bullet") continue;
    if (fact.parentId === undefined) {
      warnings.push({ factId: fact.id, reason: "bullet-without-parent" });
      continue;
    }
    if (!selectedIds.has(fact.parentId)) {
      warnings.push({ factId: fact.id, reason: "parent-not-selected" });
      continue;
    }
    const list = bulletsByParent.get(fact.parentId);
    if (list === undefined) bulletsByParent.set(fact.parentId, [textOf(entry)]);
    else list.push(textOf(entry));
  }

  const summaries: string[] = [];
  const experience: ExperienceEntry[] = [];
  const projects: ExperienceEntry[] = [];
  const education: ExperienceEntry[] = [];
  const skills: string[] = [];

  for (const entry of ordered) {
    const fact = byId.get(entry.factId)!;
    switch (fact.kind) {
      case "summary":
        summaries.push(textOf(entry));
        break;
      case "skill":
        skills.push(textOf(entry));
        break;
      case "bullet":
        break; // handled above
      case "narrative":
        // Narrative facts are cover-letter source material, not resume lines.
        // Selecting one into a resume variant is a mistake worth surfacing
        // rather than a silent omission.
        warnings.push({ factId: fact.id, reason: "narrative-not-in-resume" });
        break;
      case "role":
      case "project":
      case "education": {
        const target = fact.kind === "role"
          ? experience
          : fact.kind === "project"
          ? projects
          : education;
        target.push({
          title: textOf(entry),
          bullets: bulletsByParent.get(fact.id) ?? [],
          ...(fact.organization !== undefined ? { organization: fact.organization } : {}),
          ...(formatDateRange(fact.startDate, fact.endDate) !== undefined
            ? { dates: formatDateRange(fact.startDate, fact.endDate)! }
            : {}),
        });
        break;
      }
    }
  }

  const sections: ResumeSection[] = [];
  if (summaries.length > 0) sections.push({ kind: "summary", paragraphs: summaries });
  if (experience.length > 0) {
    sections.push({ kind: "experience", heading: "Experience", entries: experience });
  }
  if (projects.length > 0) {
    sections.push({ kind: "experience", heading: "Projects", entries: projects });
  }
  if (education.length > 0) {
    sections.push({ kind: "experience", heading: "Education", entries: education });
  }
  if (skills.length > 0) sections.push({ kind: "skills", items: skills });

  return { resume: { identity, sections }, warnings };
}

/** The contact line under the name: whatever identity provides, in fixed order. */
export function contactLine(identity: Identity): string {
  return [
    identity.location,
    identity.email,
    identity.phone,
    ...identity.links,
  ].filter((part): part is string => part !== undefined && part !== "").join("  ·  ");
}
