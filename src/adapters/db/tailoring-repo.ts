import type { Sql } from "@platform/db.ts";
import type { FactId, PostingId, VariantId } from "@platform/ids.ts";
import type {
  PendingRun,
  ProposalDecision,
  StoredProposal,
  StoredRun,
  TailoringRepo,
} from "@domain/dossier/proposals.ts";
import type { RewriteProposal } from "@domain/dossier/tailoring.ts";
import type { LlmUsage } from "@domain/llm.ts";

interface RunRow {
  id: string;
  variant_id: string;
  posting_id: string;
  model: string;
  fact_count: number;
  proposal_count: number;
  created_at: Date;
}

interface ProposalRow {
  id: string;
  run_id: string;
  fact_id: string;
  source_text: string;
  proposed_text: string;
  rationale: string;
  similarity: number;
  novel_terms: string[];
  flagged: boolean;
  decision: string;
  decided_at: Date | null;
}

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    variantId: row.variant_id as VariantId,
    postingId: row.posting_id as PostingId,
    model: row.model,
    factCount: Number(row.fact_count),
    proposalCount: Number(row.proposal_count),
    createdAt: row.created_at,
  };
}

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    runId: row.run_id,
    factId: row.fact_id as FactId,
    sourceText: row.source_text,
    proposedText: row.proposed_text,
    rationale: row.rationale,
    similarity: Number(row.similarity),
    novelTerms: row.novel_terms,
    flagged: row.flagged,
    decision: row.decision as ProposalDecision,
    decidedAt: row.decided_at,
  };
}

const RUN_COLUMNS = "id, variant_id, posting_id, model, fact_count, proposal_count, created_at";
const PROPOSAL_COLUMNS = `id, run_id, fact_id, source_text, proposed_text, rationale,
                          similarity, novel_terms, flagged, decision, decided_at`;

export class PostgresTailoringRepo implements TailoringRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async saveRun(input: {
    variantId: VariantId;
    postingId: PostingId;
    model: string;
    factCount: number;
    usage: LlmUsage;
    proposals: readonly RewriteProposal[];
  }): Promise<StoredRun> {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<RunRow[]>`
        INSERT INTO dossier.tailoring_runs
          (variant_id, posting_id, model, fact_count, proposal_count, usage)
        VALUES (${input.variantId}, ${input.postingId}, ${input.model},
                ${input.factCount}, ${input.proposals.length},
                ${tx.json(input.usage as never)})
        RETURNING ${tx.unsafe(RUN_COLUMNS)}
      `;
      const run = toRun(rows[0]!);
      for (const proposal of input.proposals) {
        await tx`
          INSERT INTO dossier.rewrite_proposals
            (run_id, fact_id, source_text, proposed_text, rationale,
             similarity, novel_terms, flagged)
          VALUES (${run.id}, ${proposal.factId}, ${proposal.sourceText},
                  ${proposal.proposedText}, ${proposal.rationale},
                  ${proposal.drift.similarity},
                  ${proposal.drift.novelTerms as string[]}, ${proposal.drift.flagged})
        `;
      }
      return run;
    });
  }

  async latestRunFor(variantId: VariantId): Promise<StoredRun | null> {
    const rows = await this.#sql<RunRow[]>`
      SELECT ${this.#sql.unsafe(RUN_COLUMNS)} FROM dossier.tailoring_runs
      WHERE variant_id = ${variantId}
      ORDER BY created_at DESC LIMIT 1
    `;
    const row = rows[0];
    return row ? toRun(row) : null;
  }

  async getRun(id: string): Promise<StoredRun | null> {
    const rows = await this.#sql<RunRow[]>`
      SELECT ${this.#sql.unsafe(RUN_COLUMNS)} FROM dossier.tailoring_runs WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toRun(row) : null;
  }

  async proposalsFor(runId: string): Promise<StoredProposal[]> {
    const rows = await this.#sql<ProposalRow[]>`
      SELECT ${this.#sql.unsafe(PROPOSAL_COLUMNS)} FROM dossier.rewrite_proposals
      WHERE run_id = ${runId}
      -- Flagged first: the ones needing the closest look lead the queue.
      ORDER BY flagged DESC, similarity ASC, id
    `;
    return rows.map(toProposal);
  }

  async getProposal(id: string): Promise<StoredProposal | null> {
    const rows = await this.#sql<ProposalRow[]>`
      SELECT ${this.#sql.unsafe(PROPOSAL_COLUMNS)} FROM dossier.rewrite_proposals
      WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toProposal(row) : null;
  }

  /** A decision is recorded once; re-deciding an already-decided row is a no-op. */
  async decide(id: string, decision: Exclude<ProposalDecision, "pending">): Promise<void> {
    await this.#sql`
      UPDATE dossier.rewrite_proposals
      SET decision = ${decision}, decided_at = now()
      WHERE id = ${id} AND decision = 'pending'
    `;
  }

  /**
   * The review queue, for the dashboard. Grouped by run because that is the
   * page a reviewer opens; the posting title comes from the posting when it is
   * still listed, and falls back to the id when the listing is gone (§4 — the
   * run outlives the posting, so this cannot be an inner join).
   */
  async pendingRuns(): Promise<readonly PendingRun[]> {
    const rows = await this.#sql<
      {
        run_id: string;
        variant_id: string;
        variant_name: string;
        posting_title: string | null;
        posting_id: string;
        pending: string;
        flagged: string;
        created_at: Date;
      }[]
    >`
      SELECT r.id            AS run_id,
             r.variant_id    AS variant_id,
             v.name          AS variant_name,
             p.title         AS posting_title,
             r.posting_id    AS posting_id,
             count(*)::text  AS pending,
             count(*) FILTER (WHERE pr.flagged)::text AS flagged,
             r.created_at    AS created_at
      FROM dossier.rewrite_proposals pr
      JOIN dossier.tailoring_runs r ON r.id = pr.run_id
      JOIN dossier.variants v ON v.id = r.variant_id
      LEFT JOIN discovery.postings p ON p.id = r.posting_id
      WHERE pr.decision = 'pending'
      GROUP BY r.id, r.variant_id, v.name, p.title, r.posting_id, r.created_at
      ORDER BY r.created_at DESC
    `;
    return rows.map((row) => ({
      runId: row.run_id,
      variantId: row.variant_id as VariantId,
      variantName: row.variant_name,
      postingTitle: row.posting_title ?? row.posting_id,
      pending: Number(row.pending),
      flagged: Number(row.flagged),
      createdAt: row.created_at,
    }));
  }
}
