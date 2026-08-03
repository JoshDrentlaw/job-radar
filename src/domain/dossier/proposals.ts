/**
 * Ports for the review queue (§8 rule 5: nothing enters a variant unreviewed).
 *
 * Proposals are stored rather than applied. The only path from a proposal into
 * a variant runs through an explicit accept, which is why these are separate
 * from the variant repo entirely.
 */

import type { FactId, PostingId, VariantId } from "@platform/ids.ts";
import type { LlmUsage } from "@domain/llm.ts";
import type { RewriteProposal } from "./tailoring.ts";
import type { DraftParagraph } from "./cover-letter.ts";

export type ProposalDecision = "pending" | "accepted" | "rejected";

export interface StoredRun {
  readonly id: string;
  readonly variantId: VariantId;
  readonly postingId: PostingId;
  readonly model: string;
  readonly factCount: number;
  readonly proposalCount: number;
  readonly createdAt: Date;
}

export interface StoredProposal {
  readonly id: string;
  readonly runId: string;
  readonly factId: FactId;
  /** The canonical text as it stood when proposed — what the reviewer compared. */
  readonly sourceText: string;
  readonly proposedText: string;
  readonly rationale: string;
  readonly similarity: number;
  readonly novelTerms: readonly string[];
  readonly flagged: boolean;
  readonly decision: ProposalDecision;
  readonly decidedAt: Date | null;
}

export interface TailoringRepo {
  saveRun(input: {
    variantId: VariantId;
    postingId: PostingId;
    model: string;
    factCount: number;
    usage: LlmUsage;
    proposals: readonly RewriteProposal[];
  }): Promise<StoredRun>;
  latestRunFor(variantId: VariantId): Promise<StoredRun | null>;
  getRun(id: string): Promise<StoredRun | null>;
  proposalsFor(runId: string): Promise<StoredProposal[]>;
  getProposal(id: string): Promise<StoredProposal | null>;
  decide(id: string, decision: Exclude<ProposalDecision, "pending">): Promise<void>;
}

/** Cover letters. */

export interface StoredParagraph {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly rationale: string;
  readonly citedFactIds: readonly FactId[];
}

export interface StoredDocument {
  readonly id: string;
  readonly kind: "cover_letter";
  readonly variantId: VariantId | null;
  readonly postingId: PostingId | null;
  readonly model: string | null;
  readonly status: "draft" | "accepted";
  readonly paragraphs: readonly StoredParagraph[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocumentRepo {
  create(input: {
    variantId: VariantId | null;
    postingId: PostingId | null;
    model: string;
    paragraphs: readonly DraftParagraph[];
  }): Promise<StoredDocument>;
  get(id: string): Promise<StoredDocument | null>;
  listForVariant(variantId: VariantId): Promise<StoredDocument[]>;
  /** Edit one paragraph's text — the user's own wording always wins. */
  updateParagraph(paragraphId: string, text: string): Promise<void>;
  removeParagraph(paragraphId: string): Promise<void>;
  accept(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
