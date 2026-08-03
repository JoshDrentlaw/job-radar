/** @jsxImportSource hono/jsx */

/**
 * The review flow (§8 rule 5): "Show every rewrite side-by-side with its
 * original before it can be accepted. Nothing enters a variant unreviewed."
 *
 * This page is the only path from a model proposal into a variant. Accepting
 * writes the rewording into the variant's entry for that fact; rejecting
 * records the decision and changes nothing. Both are one click, and neither
 * is reversible-by-accident: the canonical fact is never touched either way.
 */

import { type Context, Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDateTime, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { asVariantId, type PostingId, type VariantId } from "@platform/ids.ts";
import {
  type Identity,
  IDENTITY_SETTING,
  type ResumeFact,
  type ResumeVariant,
  VariantFrozenError,
} from "@domain/dossier/types.ts";
import type { StoredProposal, StoredRun } from "@domain/dossier/proposals.ts";
import {
  FabricationError,
  MalformedProposalError,
  proposeTailoring,
} from "@domain/dossier/tailoring.ts";
import { proposeCoverLetter } from "@domain/dossier/cover-letter.ts";
import { LlmRefusalError, LlmTruncatedError } from "@domain/llm.ts";
import type { Posting } from "@domain/discovery/types.ts";

type Ctx = Context<AppEnv>;

function parseVariantId(raw: string): VariantId | null {
  try {
    return asVariantId(raw);
  } catch {
    return null;
  }
}

const ProposalCard: FC<{
  proposal: StoredProposal;
  fact: ResumeFact | undefined;
  csrfToken: string;
}> = ({ proposal, fact, csrfToken }) => (
  <article class={`proposal${proposal.flagged ? " proposal-flagged" : ""}`}>
    <div class="meta-line">
      {fact !== undefined && <span class="chip">{fact.kind}</span>}
      {proposal.flagged
        ? <span class="chip warn">needs a closer look</span>
        : <span class="chip ok">no drift detected</span>}
      {proposal.decision !== "pending" && (
        <span class={`chip ${proposal.decision === "accepted" ? "ok" : "muted"}`}>
          {proposal.decision}
        </span>
      )}
    </div>

    <div class="rewrite-pair gap-above-tight">
      <div>
        <p class="field-hint">Canonical fact</p>
        <p class="fact-text rewrite-original">{proposal.sourceText}</p>
      </div>
      <div>
        <p class="field-hint">Proposed wording</p>
        <p class="fact-text">{proposal.proposedText}</p>
      </div>
    </div>

    {proposal.rationale !== "" && <p class="field-hint gap-above-tight">{proposal.rationale}</p>}

    {proposal.novelTerms.length > 0 && (
      <Notice kind="warn">
        Not present in the canonical fact:{" "}
        <strong>{proposal.novelTerms.join(", ")}</strong>. Check these are things you actually did
        before accepting — this is where invented specifics show up.
      </Notice>
    )}

    {proposal.decision === "pending" && (
      <div class="row gap-above-tight">
        <form method="post" action={`/dossier/proposals/${proposal.id}/accept`} class="inline-form">
          <CsrfField token={csrfToken} />
          <button type="submit" class="primary">Accept wording</button>
        </form>
        <form method="post" action={`/dossier/proposals/${proposal.id}/reject`} class="inline-form">
          <CsrfField token={csrfToken} />
          <button type="submit" class="quiet">Reject</button>
        </form>
      </div>
    )}
  </article>
);

const ReviewPage: FC<{
  variant: ResumeVariant;
  run: StoredRun;
  proposals: readonly StoredProposal[];
  facts: readonly ResumeFact[];
  csrfToken: string;
  notice?: string;
  error?: string;
}> = (props) => {
  const byId = new Map(props.facts.map((f) => [f.id as string, f]));
  const pending = props.proposals.filter((p) => p.decision === "pending");
  const decided = props.proposals.filter((p) => p.decision !== "pending");

  return (
    <Layout title="Review rewrites" current="dossier" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Proposed rewrites</h1>
          <p class="lede">
            Every proposal is a rewording of a fact that already existed — the model cannot add
            facts, and a response citing an unknown fact is rejected whole. Nothing below is in your
            variant until you accept it.
          </p>
        </div>
        <a class="button quiet" href={`/dossier/variants/${props.variant.id}`}>
          ← {props.variant.name}
        </a>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      <section class="panel">
        <header>
          <h2>Run provenance</h2>
        </header>
        <p class="field-hint">
          {props.run.model} · {props.run.factCount} facts sent · {props.run.proposalCount}{" "}
          rewrites proposed · targeted <code>{props.run.postingId}</code> ·{" "}
          {formatDateTime(props.run.createdAt)}
        </p>
      </section>

      <section class="panel">
        <header>
          <h2>Awaiting your decision</h2>
          <span class="chip">{pending.length}</span>
        </header>
        {pending.length === 0
          ? <p class="empty">Everything in this run has been decided.</p>
          : pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              fact={byId.get(proposal.factId)}
              csrfToken={props.csrfToken}
            />
          ))}
      </section>

      {decided.length > 0 && (
        <section class="panel">
          <details>
            <summary>
              <h2>Already decided ({decided.length})</h2>
            </summary>
            {decided.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                fact={byId.get(proposal.factId)}
                csrfToken={props.csrfToken}
              />
            ))}
          </details>
        </section>
      )}
    </Layout>
  );
};

export const tailoringRoutes = new Hono<AppEnv>();

/** Turn a domain failure into a message worth reading. */
function explain(error: unknown): string | null {
  if (error instanceof FabricationError) return error.message;
  if (error instanceof MalformedProposalError) return error.message;
  if (error instanceof LlmRefusalError) {
    return `The model declined this request${
      error.category !== null ? ` (${error.category})` : ""
    }. Nothing was generated.`;
  }
  if (error instanceof LlmTruncatedError) return error.message;
  if (error instanceof Error && error.name === "LlmError") return error.message;
  return null;
}

async function loadTarget(
  c: Ctx,
  variant: ResumeVariant,
): Promise<{ posting: Posting; companyName: string } | string> {
  if (variant.targetPostingId === undefined) {
    return "This variant has no target posting. Set one before tailoring — there is nothing " +
      "to tailor toward otherwise.";
  }
  const services = c.get("services");
  const posting = await services.postings.get(variant.targetPostingId);
  if (posting === null) {
    return `The target posting ${variant.targetPostingId} is no longer stored, so there is ` +
      `nothing to tailor against.`;
  }
  const board = await services.boards.get(posting.boardId);
  return { posting, companyName: board?.companyName ?? posting.boardId };
}

/** Propose rewrites for a variant's target posting. Writes proposals, not variants. */
tailoringRoutes.post("/dossier/variants/:id/tailor", async (c) => {
  const id = parseVariantId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const variant = await services.variants.get(id);
  if (variant === null) return c.notFound();

  const back = (key: "error" | "notice", message: string) =>
    c.redirect(`/dossier/variants/${id}?${key}=${encodeURIComponent(message)}`, 303);

  if (services.llm === null) {
    return back("error", "No Anthropic API key is configured (ANTHROPIC_API_KEY).");
  }
  if (variant.frozen) {
    return back(
      "error",
      `Variant "${variant.name}" is frozen; tailoring would have nowhere to go.`,
    );
  }

  const target = await loadTarget(c, variant);
  if (typeof target === "string") return back("error", target);

  const facts = await services.facts.list();
  try {
    const result = await proposeTailoring(services.llm, facts, {
      postingId: target.posting.id,
      title: target.posting.title,
      companyName: target.companyName,
      descriptionText: target.posting.descriptionText,
    });
    if (result.proposals.length === 0) {
      return back("notice", "The model proposed no rewrites — your facts already read well here.");
    }
    const run = await services.tailoring.saveRun({
      variantId: id,
      postingId: target.posting.id,
      model: result.model,
      factCount: result.factCount,
      usage: result.usage,
      proposals: result.proposals,
    });
    c.get("logger").info("tailoring proposed", {
      variantId: id,
      proposals: result.proposals.length,
      flagged: result.proposals.filter((p) => p.drift.flagged).length,
      cacheRead: result.usage.cacheReadInputTokens,
    });
    return c.redirect(`/dossier/runs/${run.id}`, 303);
  } catch (error) {
    const message = explain(error);
    if (message !== null) {
      c.get("logger").warn("tailoring rejected", { variantId: id, reason: message });
      return back("error", message);
    }
    throw error;
  }
});

tailoringRoutes.get("/dossier/runs/:runId", async (c) => {
  const services = c.get("services");
  const run = await services.tailoring.getRun(c.req.param("runId") ?? "");
  if (run === null) return c.notFound();
  const variant = await services.variants.get(run.variantId);
  if (variant === null) return c.notFound();

  const [proposals, facts] = await Promise.all([
    services.tailoring.proposalsFor(run.id),
    services.facts.list(),
  ]);
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <ReviewPage
      variant={variant}
      run={run}
      proposals={proposals}
      facts={facts}
      csrfToken={c.get("csrfToken")}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

/**
 * Accept: write the reviewed wording into the variant's entry for that fact.
 * This is the only code path in the application that puts model-authored text
 * into a variant, and it runs only after a human clicked accept.
 */
tailoringRoutes.post("/dossier/proposals/:id/accept", async (c) => {
  const services = c.get("services");
  const proposalId = c.req.param("id") ?? "";
  const proposal = await services.tailoring.getProposal(proposalId);
  if (proposal === null) return c.notFound();
  const run = await services.tailoring.getRun(proposal.runId);
  if (run === null) return c.notFound();

  const back = (key: "error" | "notice", message: string) =>
    c.redirect(`/dossier/runs/${run.id}?${key}=${encodeURIComponent(message)}`, 303);

  if (proposal.decision !== "pending") return back("notice", "That proposal was already decided.");

  const variant = await services.variants.get(run.variantId);
  if (variant === null) return c.notFound();

  const ordered = [...variant.entries].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((entry) => entry.factId === proposal.factId);
  const updated = index === -1
    // The fact was not in the variant; accepting the wording adds it, since
    // that is plainly what accepting a rewrite of it means.
    ? [...ordered, {
      factId: proposal.factId,
      position: ordered.length,
      rewrittenText: proposal.proposedText,
    }]
    : ordered.map((entry, i) =>
      i === index ? { ...entry, rewrittenText: proposal.proposedText } : entry
    );

  try {
    await services.variants.setEntries(
      variant.id,
      updated.map((entry, position) => ({ ...entry, position })),
    );
  } catch (error) {
    if (error instanceof VariantFrozenError) return back("error", error.message);
    throw error;
  }
  await services.tailoring.decide(proposalId, "accepted");
  return back("notice", "Accepted — the variant now uses that wording.");
});

tailoringRoutes.post("/dossier/proposals/:id/reject", async (c) => {
  const services = c.get("services");
  const proposalId = c.req.param("id") ?? "";
  const proposal = await services.tailoring.getProposal(proposalId);
  if (proposal === null) return c.notFound();
  await services.tailoring.decide(proposalId, "rejected");
  return c.redirect(`/dossier/runs/${proposal.runId}?notice=Rejected.`, 303);
});

/** Cover letters: generated from facts, every claim cited, reviewed before use. */
tailoringRoutes.post("/dossier/variants/:id/cover-letter", async (c) => {
  const id = parseVariantId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const variant = await services.variants.get(id);
  if (variant === null) return c.notFound();

  const back = (key: "error" | "notice", message: string) =>
    c.redirect(`/dossier/variants/${id}?${key}=${encodeURIComponent(message)}`, 303);

  if (services.llm === null) {
    return back("error", "No Anthropic API key is configured (ANTHROPIC_API_KEY).");
  }
  const target = await loadTarget(c, variant);
  if (typeof target === "string") return back("error", target);

  const [facts, identity] = await Promise.all([
    services.facts.list(),
    services.settings.get<Identity>(IDENTITY_SETTING),
  ]);

  try {
    const result = await proposeCoverLetter(services.llm, facts, {
      postingId: target.posting.id,
      title: target.posting.title,
      companyName: target.companyName,
      descriptionText: target.posting.descriptionText,
    }, identity);
    const document = await services.documents.create({
      variantId: id,
      postingId: target.posting.id as PostingId,
      model: result.model,
      paragraphs: result.paragraphs,
    });
    return c.redirect(`/dossier/letters/${document.id}`, 303);
  } catch (error) {
    const message = explain(error);
    if (message !== null) {
      c.get("logger").warn("cover letter rejected", { variantId: id, reason: message });
      return back("error", message);
    }
    throw error;
  }
});
