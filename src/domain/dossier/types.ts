/**
 * Dossier domain types (§8).
 *
 * The base resume is structured data, not a document. A variant is a diff
 * against the fact set — which facts appear, in which order, with what
 * per-fact rewording — and documents are rendered from variants, never edited
 * as blobs. In M4 every rewrite is user-authored; the M5 tailoring flow will
 * produce proposals into the same shape.
 */

import type { FactId, PostingId, VariantId } from "@platform/ids.ts";

export const FACT_KINDS = [
  "summary",
  "role",
  "bullet",
  "skill",
  "education",
  "project",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value);
}

/** Kinds that can own bullets. */
export const PARENT_KINDS: ReadonlySet<FactKind> = new Set(["role", "project"]);

export interface ResumeFact {
  readonly id: FactId;
  readonly kind: FactKind;
  /** Bullets belong to a role or project. */
  readonly parentId?: FactId;
  /** The canonical, true statement. */
  readonly text: string;
  readonly tags: readonly string[];
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly organization?: string;
  /** False = retired: out of the pickers, still resolvable by old variants. */
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FactInput {
  readonly kind: FactKind;
  readonly parentId?: FactId;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly organization?: string;
}

export interface VariantFactEntry {
  readonly factId: FactId;
  readonly position: number;
  /** Manual rewording for this variant; absent = canonical text renders. */
  readonly rewrittenText?: string;
}

export interface ResumeVariant {
  readonly id: VariantId;
  readonly name: string;
  readonly parentVariantId?: VariantId;
  readonly targetPostingId?: PostingId;
  readonly entries: readonly VariantFactEntry[];
  /** Immutable once set (§8). Mutating calls fail rather than silently no-op. */
  readonly frozen: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface VariantSummary {
  readonly id: VariantId;
  readonly name: string;
  readonly targetPostingId?: PostingId;
  readonly factCount: number;
  readonly rewriteCount: number;
  readonly frozen: boolean;
  readonly updatedAt: Date;
}

/**
 * The header block of a rendered resume. Not facts — identity. Lives in
 * app.settings under IDENTITY_SETTING, edited on the dossier page.
 */
export interface Identity {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly location?: string;
  /** Rendered verbatim in the contact line: URLs, handles. */
  readonly links: readonly string[];
}

export const IDENTITY_SETTING = "dossier.identity";

export class VariantFrozenError extends Error {
  override readonly name = "VariantFrozenError";
  constructor(name: string) {
    super(`Variant "${name}" is frozen and cannot be modified. Duplicate it to keep working.`);
  }
}

export class FactInUseError extends Error {
  override readonly name = "FactInUseError";
  constructor() {
    super(
      "This fact is cited by at least one variant and cannot be deleted. Retire it instead — " +
        "retired facts leave the pickers but stay resolvable by every variant that cites them.",
    );
  }
}

/** Ports. */

export interface FactRepo {
  list(): Promise<ResumeFact[]>;
  get(id: FactId): Promise<ResumeFact | null>;
  create(input: FactInput): Promise<ResumeFact>;
  update(id: FactId, input: FactInput): Promise<ResumeFact | null>;
  setActive(id: FactId, active: boolean): Promise<void>;
  /** Throws FactInUseError when any variant cites the fact. */
  remove(id: FactId): Promise<void>;
  /** Swap sort order with the adjacent sibling (same kind and parent). */
  move(id: FactId, direction: "up" | "down"): Promise<void>;
}

export interface VariantRepo {
  list(): Promise<VariantSummary[]>;
  get(id: VariantId): Promise<ResumeVariant | null>;
  create(input: {
    name: string;
    targetPostingId?: PostingId;
    parentVariantId?: VariantId;
    entries?: readonly VariantFactEntry[];
  }): Promise<ResumeVariant>;
  rename(id: VariantId, name: string): Promise<void>;
  /** Full replacement of the entry set. Throws VariantFrozenError when frozen. */
  setEntries(id: VariantId, entries: readonly VariantFactEntry[]): Promise<void>;
  /** One-way. */
  freeze(id: VariantId): Promise<void>;
  /** Refuses frozen variants — they are history (§8). */
  remove(id: VariantId): Promise<void>;
}
