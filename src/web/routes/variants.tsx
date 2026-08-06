/** @jsxImportSource hono/jsx */

/**
 * Variants (§8): each one a diff against the fact set — selection, order,
 * per-fact rewording. Documents are rendered from a variant on demand, never
 * stored or edited as blobs, and a frozen variant refuses every mutation.
 * In M4 every rewrite here is typed by the user; M5's tailoring proposes into
 * this same shape and nothing enters a variant unreviewed.
 */

import { type Context, Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, Field, formatDateTime, Notice, relativeAge } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { asFactId, asPostingId, asVariantId, type FactId, type VariantId } from "@platform/ids.ts";
import {
  type Identity,
  IDENTITY_SETTING,
  type ResumeFact,
  type ResumeVariant,
  type VariantFactEntry,
  VariantFrozenError,
  type VariantSummary,
} from "@domain/dossier/types.ts";
import { assembleResume, type AssemblyWarning } from "@domain/dossier/resume.ts";
import { renderResumePdf } from "@adapters/render/pdf.ts";
import { renderResumeDocx } from "@adapters/render/docx.ts";

function parseVariantId(raw: string): VariantId | null {
  try {
    return asVariantId(raw);
  } catch {
    return null;
  }
}

const VariantsPage: FC<{
  variants: readonly VariantSummary[];
  csrfToken: string;
  now: Date;
  error?: string;
  notice?: string;
}> = (props) => (
  <Layout title="Variants" current="dossier" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>Resume variants</h1>
        <p class="lede">
          A variant is which facts appear, in what order, with what rewording. Rendered to PDF and
          DOCX on demand — the same variant produces the same bytes every time.
        </p>
      </div>
      <a class="button quiet" href="/dossier">← Fact set</a>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
    {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

    <section class="panel">
      <header>
        <h2>Variants</h2>
      </header>
      {props.variants.length === 0
        ? <p class="empty">No variants yet. Create the first one below.</p>
        : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th class="numeric">Facts</th>
                  <th class="numeric">Rewrites</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {props.variants.map((variant) => (
                  <tr>
                    <td>
                      <a class="posting-title" href={`/dossier/variants/${variant.id}`}>
                        {variant.name}
                      </a>
                      {variant.targetPostingId !== undefined && (
                        <div class="field-hint">targets {variant.targetPostingId}</div>
                      )}
                    </td>
                    <td class="numeric">{variant.factCount}</td>
                    <td class="numeric">{variant.rewriteCount}</td>
                    <td>
                      {variant.frozen
                        ? <span class="chip muted">frozen</span>
                        : <span class="chip ok">editable</span>}
                    </td>
                    <td>{relativeAge(variant.updatedAt, props.now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>

    <section class="panel stack">
      <header>
        <h2>New variant</h2>
      </header>
      <form method="post" action="/dossier/variants" class="stack">
        <CsrfField token={props.csrfToken} />
        <div class="field-row">
          <Field label="Name" for="variant-name">
            <input
              id="variant-name"
              type="text"
              name="name"
              required
              maxlength={80}
              placeholder="backend-heavy"
            />
          </Field>
          <Field label="Target posting id" for="variant-target" hint="Optional.">
            <input
              id="variant-target"
              type="text"
              name="target_posting_id"
              placeholder="greenhouse:acme:12345"
            />
          </Field>
        </div>
        <div class="row">
          <button type="submit" class="primary">Create variant</button>
        </div>
      </form>
    </section>
  </Layout>
);

const WARNING_TEXT: Record<AssemblyWarning["reason"], string> = {
  "bullet-without-parent": "a selected bullet has no parent fact and will not render",
  "parent-not-selected": "a selected bullet's role/project is not selected, so it will not render",
  "narrative-not-in-resume":
    "a narrative fact is selected; narrative facts are cover-letter source material and never " +
    "render on a resume",
};

const VariantEditorPage: FC<{
  variant: ResumeVariant;
  facts: readonly ResumeFact[];
  warnings: readonly AssemblyWarning[];
  identityMissing: boolean;
  llmConfigured: boolean;
  targetTitle?: string;
  latestRunId?: string;
  letters: readonly { id: string; status: string; createdAt: Date }[];
  csrfToken: string;
  error?: string;
  notice?: string;
}> = (props) => {
  const { variant } = props;
  const byId = new Map(props.facts.map((f) => [f.id as string, f]));
  const ordered = [...variant.entries].sort((a, b) => a.position - b.position);
  const selected = new Set(ordered.map((e) => e.factId as string));
  const available = props.facts.filter((f) => f.active && !selected.has(f.id));
  const act = (suffix: string) => `/dossier/variants/${variant.id}${suffix}`;

  return (
    <Layout title={variant.name} current="dossier" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>{variant.name}</h1>
          <p class="meta-line">
            {variant.frozen
              ? <span class="chip muted">frozen — immutable</span>
              : <span class="chip ok">editable</span>}
            {variant.targetPostingId !== undefined && (
              <a href={`/matches/${encodeURIComponent(variant.targetPostingId)}`}>
                targets {variant.targetPostingId}
              </a>
            )}
            <span>{ordered.length} facts</span>
          </p>
        </div>
        <div class="row">
          <a class="button primary" href={act("/resume.pdf")}>PDF</a>
          <a class="button primary" href={act("/resume.docx")}>DOCX</a>
        </div>
      </div>

      {!variant.frozen && (
        <section class="panel stack">
          <header>
            <h2>Tailoring</h2>
          </header>
          <p class="panel-note">
            Proposes rewordings of facts you already have, against this variant's target posting.
            The model cannot add facts: a response citing a fact that does not exist is rejected
            whole, and nothing reaches this variant until you accept it side-by-side with the
            original.
          </p>
          {props.targetTitle === undefined
            ? (
              <Notice kind="warn">
                This variant has no target posting, so there is nothing to tailor toward. Set one
                below.
              </Notice>
            )
            : <p class="field-hint">Targeting {props.targetTitle}.</p>}
          {!props.llmConfigured && (
            <Notice kind="warn">
              No Anthropic API key is configured (ANTHROPIC_API_KEY), so tailoring and cover letters
              are unavailable. Everything else on this page works by hand.
            </Notice>
          )}
          <div class="row">
            <form method="post" action={act("/tailor")} class="inline-form">
              <CsrfField token={props.csrfToken} />
              <button
                type="submit"
                class="primary"
                disabled={!props.llmConfigured || props.targetTitle === undefined}
              >
                Propose rewrites
              </button>
            </form>
            <form method="post" action={act("/cover-letter")} class="inline-form">
              <CsrfField token={props.csrfToken} />
              <button
                type="submit"
                class="quiet"
                disabled={!props.llmConfigured || props.targetTitle === undefined}
              >
                Draft a cover letter
              </button>
            </form>
            {props.latestRunId !== undefined && (
              <a class="button quiet" href={`/dossier/runs/${props.latestRunId}`}>
                Latest proposals
              </a>
            )}
          </div>
          {props.letters.length > 0 && (
            <div class="gap-above">
              <p class="field-hint">Cover letter drafts:</p>
              <ul class="citation-list">
                {props.letters.map((letter) => (
                  <li key={letter.id}>
                    <a href={`/dossier/letters/${letter.id}`}>
                      {formatDateTime(letter.createdAt)}
                    </a>{" "}
                    <span class={`chip ${letter.status === "accepted" ? "ok" : "warn"}`}>
                      {letter.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}
      {props.identityMissing && (
        <Notice kind="warn">
          No identity is set, so rendered documents have an empty header.{" "}
          <a href="/dossier">Set it on the fact set page.</a>
        </Notice>
      )}
      {props.warnings.map((warning) => (
        <Notice kind="warn">
          {WARNING_TEXT[warning.reason]}:{" "}
          "{byId.get(warning.factId as string)?.text.slice(0, 80) ?? warning.factId}"
        </Notice>
      ))}

      <section class="panel">
        <header>
          <h2>Included, in render order</h2>
        </header>
        {ordered.length === 0 && (
          <p class="empty">
            Nothing selected yet. {!variant.frozen && "Add facts below, or start from everything:"}
          </p>
        )}
        {ordered.length === 0 && !variant.frozen && (
          <form method="post" action={act("/entries/add-all")} class="inline-form">
            <CsrfField token={props.csrfToken} />
            <button type="submit" class="quiet">Include all active facts</button>
          </form>
        )}
        {ordered.map((entry) => {
          const fact = byId.get(entry.factId as string);
          // RESTRICT guarantees the fact exists; this is belt-and-braces.
          if (fact === undefined) return null;
          const rewritten = entry.rewrittenText !== undefined;
          return (
            <div class="fact-row">
              <div class="fact-main">
                <p class="meta-line">
                  <span class="chip">{fact.kind}</span>
                  {!fact.active && <span class="chip muted">retired</span>}
                  {rewritten && <span class="chip warn">reworded</span>}
                </p>
                {rewritten
                  ? (
                    <div class="rewrite-pair">
                      <p class="fact-text rewrite-original" title="Canonical fact">
                        {fact.text}
                      </p>
                      <p class="fact-text" title="This variant's wording">
                        {entry.rewrittenText}
                      </p>
                    </div>
                  )
                  : <p class="fact-text">{fact.text}</p>}
                {!variant.frozen && (
                  <details class="fact-edit">
                    <summary class="button quiet">Reword for this variant</summary>
                    <form
                      method="post"
                      action={act("/entries/rewrite")}
                      class="stack fact-edit-body"
                    >
                      <CsrfField token={props.csrfToken} />
                      <input type="hidden" name="fact_id" value={fact.id} />
                      <p class="field-hint">
                        Rewording, not rewriting history: the canonical fact stays as the record.
                        Leave empty to restore it.
                      </p>
                      <textarea name="rewritten_text" rows={3}>
                        {entry.rewrittenText ?? ""}
                      </textarea>
                      <div class="row">
                        <button type="submit" class="primary">Save wording</button>
                      </div>
                    </form>
                  </details>
                )}
              </div>
              {!variant.frozen && (
                <div class="fact-actions">
                  <form method="post" action={act("/entries/move")} class="inline-form">
                    <CsrfField token={props.csrfToken} />
                    <input type="hidden" name="fact_id" value={fact.id} />
                    <input type="hidden" name="direction" value="up" />
                    <button type="submit" class="quiet" title="Move up">↑</button>
                  </form>
                  <form method="post" action={act("/entries/move")} class="inline-form">
                    <CsrfField token={props.csrfToken} />
                    <input type="hidden" name="fact_id" value={fact.id} />
                    <input type="hidden" name="direction" value="down" />
                    <button type="submit" class="quiet" title="Move down">↓</button>
                  </form>
                  <form method="post" action={act("/entries/remove")} class="inline-form">
                    <CsrfField token={props.csrfToken} />
                    <input type="hidden" name="fact_id" value={fact.id} />
                    <button type="submit" class="quiet danger-text">Remove</button>
                  </form>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {!variant.frozen && (
        <section class="panel">
          <header>
            <h2>Available facts</h2>
          </header>
          {available.length === 0
            ? <p class="empty">Every active fact is already included.</p>
            : available.map((fact) => (
              <div class="fact-row">
                <div class="fact-main">
                  <p class="meta-line">
                    <span class="chip">{fact.kind}</span>
                    {fact.organization !== undefined && <span>{fact.organization}</span>}
                  </p>
                  <p class="fact-text">{fact.text}</p>
                </div>
                <div class="fact-actions">
                  <form method="post" action={act("/entries/add")} class="inline-form">
                    <CsrfField token={props.csrfToken} />
                    <input type="hidden" name="fact_id" value={fact.id} />
                    <button type="submit" class="quiet">Add</button>
                  </form>
                </div>
              </div>
            ))}
        </section>
      )}

      <section class="panel stack">
        <header>
          <h2>Variant actions</h2>
        </header>
        {!variant.frozen && (
          <form method="post" action={act("/rename")} class="row">
            <CsrfField token={props.csrfToken} />
            <input type="text" name="name" value={variant.name} required maxlength={80} />
            <button type="submit" class="quiet">Rename</button>
          </form>
        )}
        <div class="row">
          <form method="post" action={act("/duplicate")} class="inline-form">
            <CsrfField token={props.csrfToken} />
            <button type="submit" class="quiet">Duplicate as new variant</button>
          </form>
          {!variant.frozen && (
            <form method="post" action={act("/freeze")} class="inline-form">
              <CsrfField token={props.csrfToken} />
              <button type="submit" class="quiet warn-text">
                Freeze (one-way — marks it as sent history)
              </button>
            </form>
          )}
          {!variant.frozen && (
            <form method="post" action={act("/delete")} class="inline-form">
              <CsrfField token={props.csrfToken} />
              <button type="submit" class="quiet danger-text">Delete variant</button>
            </form>
          )}
        </div>
      </section>
    </Layout>
  );
};

export const variantRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/** Frozen-variant mutations all land here: loud error, no silent no-op. */
function frozenRedirect(c: Ctx, id: string, error: Error): Response {
  return c.redirect(
    `/dossier/variants/${id}?error=${encodeURIComponent(error.message)}`,
    303,
  );
}

variantRoutes.get("/dossier/variants", async (c) => {
  const services = c.get("services");
  const variants = await services.variants.list();
  const error = c.req.query("error");
  const notice = c.req.query("notice");
  return c.html(
    <VariantsPage
      variants={variants}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

variantRoutes.post("/dossier/variants", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") {
    return c.redirect(`/dossier/variants?error=${encodeURIComponent("Name is required.")}`, 303);
  }
  const targetRaw = typeof body.target_posting_id === "string" ? body.target_posting_id.trim() : "";
  let targetPostingId;
  if (targetRaw !== "") {
    try {
      targetPostingId = asPostingId(targetRaw);
    } catch {
      return c.redirect(
        `/dossier/variants?error=${encodeURIComponent(`Malformed posting id: ${targetRaw}`)}`,
        303,
      );
    }
  }
  try {
    const variant = await c.get("services").variants.create({
      name,
      ...(targetPostingId !== undefined ? { targetPostingId } : {}),
    });
    return c.redirect(`/dossier/variants/${variant.id}`, 303);
  } catch (error) {
    if (isDuplicateName(error)) {
      return c.redirect(
        `/dossier/variants?error=${encodeURIComponent(`A variant named "${name}" exists.`)}`,
        303,
      );
    }
    throw error;
  }
});

function isDuplicateName(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: string }).code === "23505";
}

async function loadVariant(c: Ctx): Promise<ResumeVariant | null> {
  const id = parseVariantId(c.req.param("id") ?? "");
  if (id === null) return null;
  return await c.get("services").variants.get(id);
}

variantRoutes.get("/dossier/variants/:id", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  const services = c.get("services");
  const [facts, identity, latestRun, letters] = await Promise.all([
    services.facts.list(),
    services.settings.get<Identity>(IDENTITY_SETTING),
    services.tailoring.latestRunFor(variant.id),
    services.documents.listForVariant(variant.id),
  ]);
  const { warnings } = assembleResume(
    identity ?? { name: "", links: [] },
    facts,
    variant,
  );

  // The target's title, when it is still stored — the tailoring panel says
  // what it would aim at rather than just showing an opaque id.
  let targetTitle: string | undefined;
  if (variant.targetPostingId !== undefined) {
    const posting = await services.postings.get(variant.targetPostingId);
    if (posting !== null) {
      const board = await services.boards.get(posting.boardId);
      targetTitle = `${posting.title} at ${board?.companyName ?? posting.boardId}`;
    }
  }

  const error = c.req.query("error");
  const notice = c.req.query("notice");
  return c.html(
    <VariantEditorPage
      variant={variant}
      facts={facts}
      warnings={warnings}
      identityMissing={identity === null}
      llmConfigured={services.llm !== null}
      letters={letters.map((d) => ({
        id: d.id,
        status: d.status,
        createdAt: d.createdAt,
      }))}
      {...(targetTitle !== undefined ? { targetTitle } : {})}
      {...(latestRun !== null ? { latestRunId: latestRun.id } : {})}
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

/** Entry mutations share a load-modify-store against the ordered entry list. */
async function withEntries(
  c: Ctx,
  mutate: (
    entries: VariantFactEntry[],
    factId: FactId,
    variant: ResumeVariant,
  ) => VariantFactEntry[] | string,
  body: Record<string, unknown>,
): Promise<Response> {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();

  const factIdRaw = typeof body.fact_id === "string" ? body.fact_id : "";
  let factId: FactId;
  try {
    factId = asFactId(factIdRaw);
  } catch {
    return c.notFound();
  }

  const ordered = [...variant.entries].sort((a, b) => a.position - b.position);
  const result = mutate(ordered, factId, variant);
  if (typeof result === "string") {
    return c.redirect(
      `/dossier/variants/${variant.id}?error=${encodeURIComponent(result)}`,
      303,
    );
  }

  const renumbered = result.map((entry, index) => ({ ...entry, position: index }));
  try {
    await c.get("services").variants.setEntries(variant.id, renumbered);
  } catch (error) {
    if (error instanceof VariantFrozenError) return frozenRedirect(c, variant.id, error);
    throw error;
  }
  return c.redirect(`/dossier/variants/${variant.id}`, 303);
}

variantRoutes.post("/dossier/variants/:id/entries/add", async (c) => {
  const body = await c.req.parseBody();
  return await withEntries(c, (entries, factId) => {
    if (entries.some((e) => e.factId === factId)) return "That fact is already included.";
    return [...entries, { factId, position: entries.length }];
  }, body);
});

variantRoutes.post("/dossier/variants/:id/entries/remove", async (c) => {
  const body = await c.req.parseBody();
  return await withEntries(
    c,
    (entries, factId) => entries.filter((e) => e.factId !== factId),
    body,
  );
});

variantRoutes.post("/dossier/variants/:id/entries/move", async (c) => {
  const body = await c.req.parseBody();
  const direction = body.direction === "up" ? "up" : "down";
  return await withEntries(c, (entries, factId) => {
    const index = entries.findIndex((e) => e.factId === factId);
    if (index === -1) return "That fact is not in the variant.";
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= entries.length) return entries;
    const copy = [...entries];
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
    return copy;
  }, body);
});

variantRoutes.post("/dossier/variants/:id/entries/rewrite", async (c) => {
  const body = await c.req.parseBody();
  const text = typeof body.rewritten_text === "string" ? body.rewritten_text.trim() : "";
  return await withEntries(c, (entries, factId) => {
    const index = entries.findIndex((e) => e.factId === factId);
    if (index === -1) return "That fact is not in the variant.";
    const copy = [...entries];
    const { rewrittenText: _dropped, ...rest } = copy[index]!;
    copy[index] = text === "" ? rest : { ...rest, rewrittenText: text };
    return copy;
  }, body);
});

variantRoutes.post("/dossier/variants/:id/entries/add-all", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  const facts = await c.get("services").facts.list();
  const entries = facts
    .filter((fact) => fact.active)
    .map((fact, index) => ({ factId: fact.id, position: index }));
  try {
    await c.get("services").variants.setEntries(variant.id, entries);
  } catch (error) {
    if (error instanceof VariantFrozenError) return frozenRedirect(c, variant.id, error);
    throw error;
  }
  return c.redirect(`/dossier/variants/${variant.id}`, 303);
});

variantRoutes.post("/dossier/variants/:id/rename", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") {
    return c.redirect(
      `/dossier/variants/${variant.id}?error=${encodeURIComponent("Name is required.")}`,
      303,
    );
  }
  try {
    await c.get("services").variants.rename(variant.id, name);
  } catch (error) {
    if (error instanceof VariantFrozenError) return frozenRedirect(c, variant.id, error);
    if (isDuplicateName(error)) {
      return c.redirect(
        `/dossier/variants/${variant.id}?error=${
          encodeURIComponent(`A variant named "${name}" exists.`)
        }`,
        303,
      );
    }
    throw error;
  }
  return c.redirect(`/dossier/variants/${variant.id}?notice=Renamed.`, 303);
});

variantRoutes.post("/dossier/variants/:id/freeze", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  await c.get("services").variants.freeze(variant.id);
  return c.redirect(
    `/dossier/variants/${variant.id}?notice=${
      encodeURIComponent("Frozen. This variant is now immutable history.")
    }`,
    303,
  );
});

variantRoutes.post("/dossier/variants/:id/duplicate", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  const services = c.get("services");
  // Deterministic candidate names: "name (copy)", then "(copy 2)", …
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? `${variant.name} (copy)` : `${variant.name} (copy ${attempt + 1})`;
    try {
      const copy = await services.variants.create({
        name,
        parentVariantId: variant.id,
        entries: variant.entries,
        ...(variant.targetPostingId !== undefined
          ? { targetPostingId: variant.targetPostingId }
          : {}),
      });
      return c.redirect(`/dossier/variants/${copy.id}?notice=Duplicated.`, 303);
    } catch (error) {
      if (!isDuplicateName(error)) throw error;
    }
  }
  return c.redirect(
    `/dossier/variants/${variant.id}?error=${encodeURIComponent("Could not find a free name.")}`,
    303,
  );
});

variantRoutes.post("/dossier/variants/:id/delete", async (c) => {
  const variant = await loadVariant(c);
  if (variant === null) return c.notFound();
  try {
    await c.get("services").variants.remove(variant.id);
  } catch (error) {
    if (error instanceof VariantFrozenError) return frozenRedirect(c, variant.id, error);
    throw error;
  }
  return c.redirect("/dossier/variants?notice=Variant+deleted.", 303);
});

/** The renderers: same variant, same bytes, twice (§15). */
async function renderedResume(c: Ctx) {
  const variant = await loadVariant(c);
  if (variant === null) return null;
  const services = c.get("services");
  const [facts, identity] = await Promise.all([
    services.facts.list(),
    services.settings.get<Identity>(IDENTITY_SETTING),
  ]);
  const { resume } = assembleResume(identity ?? { name: "", links: [] }, facts, variant);
  return { resume, variant };
}

function downloadName(variant: ResumeVariant, extension: string): string {
  const safe = variant.name.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
  return `resume-${safe}.${extension}`;
}

variantRoutes.get("/dossier/variants/:id/resume.pdf", async (c) => {
  const rendered = await renderedResume(c);
  if (rendered === null) return c.notFound();
  const bytes = renderResumePdf(rendered.resume);
  c.header("Content-Type", "application/pdf");
  c.header(
    "Content-Disposition",
    `attachment; filename="${downloadName(rendered.variant, "pdf")}"`,
  );
  return c.body(bytes as unknown as ArrayBuffer);
});

variantRoutes.get("/dossier/variants/:id/resume.docx", async (c) => {
  const rendered = await renderedResume(c);
  if (rendered === null) return c.notFound();
  const bytes = renderResumeDocx(rendered.resume);
  c.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  c.header(
    "Content-Disposition",
    `attachment; filename="${downloadName(rendered.variant, "docx")}"`,
  );
  return c.body(bytes as unknown as ArrayBuffer);
});
