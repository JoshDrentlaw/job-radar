/** @jsxImportSource hono/jsx */

/**
 * Cover letter review (§8).
 *
 * "Generated from facts, every claim traceable, reviewed before use."
 *
 * Each paragraph is shown with the facts it cites, verbatim, so traceability
 * is something the reader checks rather than trusts. Paragraphs are editable
 * and deletable — the user's own wording always wins — and the letter stays a
 * draft until they accept it.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDateTime, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { StoredDocument } from "@domain/dossier/proposals.ts";
import { type Identity, IDENTITY_SETTING, type ResumeFact } from "@domain/dossier/types.ts";
import { contactLine } from "@domain/dossier/resume.ts";

const LetterPage: FC<{
  document: StoredDocument;
  facts: readonly ResumeFact[];
  identity: Identity | null;
  csrfToken: string;
  notice?: string;
  error?: string;
}> = (props) => {
  const byId = new Map(props.facts.map((f) => [f.id as string, f]));
  const accepted = props.document.status === "accepted";

  return (
    <Layout title="Cover letter" current="dossier" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Cover letter draft</h1>
          <p class="meta-line">
            {accepted
              ? <span class="chip ok">accepted</span>
              : <span class="chip warn">draft — not reviewed yet</span>}
            {props.document.model !== null && <span>{props.document.model}</span>}
            <span>{formatDateTime(props.document.createdAt)}</span>
          </p>
        </div>
        <div class="row">
          {props.document.variantId !== null && (
            <a class="button quiet" href={`/dossier/variants/${props.document.variantId}`}>
              ← Variant
            </a>
          )}
          <a class="button primary" href={`/dossier/letters/${props.document.id}/text`}>
            Plain text
          </a>
        </div>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      <Notice kind="warn">
        Every paragraph below cites the facts it was built from. Read each claim against its
        citations before you send this anywhere — a citation that does not support its sentence is
        the failure mode worth catching.
      </Notice>

      {props.document.paragraphs.length === 0 && (
        <p class="empty">Every paragraph was deleted. Generate a new draft, or write your own.</p>
      )}

      {props.document.paragraphs.map((paragraph) => (
        <section class="panel" key={paragraph.id}>
          <header>
            <h2>Paragraph {paragraph.position + 1}</h2>
          </header>

          <form
            method="post"
            action={`/dossier/letters/paragraphs/${paragraph.id}`}
            class="stack"
          >
            <CsrfField token={props.csrfToken} />
            <textarea name="text" rows={5} class="editor" required>{paragraph.text}</textarea>
            <div class="row">
              <button type="submit" class="quiet">Save my wording</button>
            </div>
          </form>

          {paragraph.rationale !== "" && (
            <p class="field-hint gap-above-tight">{paragraph.rationale}</p>
          )}

          <div class="gap-above">
            <p class="field-hint">Rests on these facts:</p>
            {paragraph.citedFactIds.length === 0
              ? <Notice kind="error">This paragraph cites nothing. Delete it.</Notice>
              : (
                <ul class="citation-list">
                  {paragraph.citedFactIds.map((factId) => {
                    const fact = byId.get(factId);
                    return (
                      <li key={factId}>
                        {fact === undefined
                          ? <span class="danger-text">A fact that no longer exists ({factId})</span>
                          : (
                            <>
                              <span class="chip">{fact.kind}</span> {fact.text}
                            </>
                          )}
                      </li>
                    );
                  })}
                </ul>
              )}
          </div>

          <form
            method="post"
            action={`/dossier/letters/paragraphs/${paragraph.id}/delete`}
            class="inline-form gap-above-tight"
          >
            <CsrfField token={props.csrfToken} />
            <button type="submit" class="quiet danger-text">Delete paragraph</button>
          </form>
        </section>
      ))}

      <section class="panel stack">
        <header>
          <h2>Letter actions</h2>
        </header>
        {props.identity === null && (
          <Notice kind="warn">
            No identity is set, so the plain-text export has no signature block.
          </Notice>
        )}
        <div class="row">
          {!accepted && props.document.paragraphs.length > 0 && (
            <form
              method="post"
              action={`/dossier/letters/${props.document.id}/accept`}
              class="inline-form"
            >
              <CsrfField token={props.csrfToken} />
              <button type="submit" class="primary">
                I have read every paragraph against its citations — accept
              </button>
            </form>
          )}
          <form
            method="post"
            action={`/dossier/letters/${props.document.id}/delete`}
            class="inline-form"
          >
            <CsrfField token={props.csrfToken} />
            <button type="submit" class="quiet danger-text">Discard draft</button>
          </form>
        </div>
      </section>
    </Layout>
  );
};

export const letterRoutes = new Hono<AppEnv>();

letterRoutes.get("/dossier/letters/:id", async (c) => {
  const services = c.get("services");
  const document = await services.documents.get(c.req.param("id") ?? "");
  if (document === null) return c.notFound();
  const [facts, identity] = await Promise.all([
    services.facts.list(),
    services.settings.get<Identity>(IDENTITY_SETTING),
  ]);
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <LetterPage
      document={document}
      facts={facts}
      identity={identity}
      csrfToken={c.get("csrfToken")}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

/** Plain text, for pasting into whatever form the company uses. */
letterRoutes.get("/dossier/letters/:id/text", async (c) => {
  const services = c.get("services");
  const document = await services.documents.get(c.req.param("id") ?? "");
  if (document === null) return c.notFound();
  const identity = await services.settings.get<Identity>(IDENTITY_SETTING);

  const body = document.paragraphs.map((p) => p.text).join("\n\n");
  const signature = identity === null
    ? ""
    : `\n\n${identity.name}${contactLine(identity) === "" ? "" : `\n${contactLine(identity)}`}`;

  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(`${body}${signature}\n`);
});

letterRoutes.post("/dossier/letters/paragraphs/:paragraphId", async (c) => {
  const services = c.get("services");
  const paragraphId = c.req.param("paragraphId") ?? "";
  const body = await c.req.parseBody();
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") {
    return c.redirect(`/dossier?error=${encodeURIComponent("Paragraph text is required.")}`, 303);
  }
  await services.documents.updateParagraph(paragraphId, text);
  return c.redirect(c.req.header("referer") ?? "/dossier", 303);
});

letterRoutes.post("/dossier/letters/paragraphs/:paragraphId/delete", async (c) => {
  await c.get("services").documents.removeParagraph(c.req.param("paragraphId") ?? "");
  return c.redirect(c.req.header("referer") ?? "/dossier", 303);
});

letterRoutes.post("/dossier/letters/:id/accept", async (c) => {
  const services = c.get("services");
  const id = c.req.param("id") ?? "";
  const document = await services.documents.get(id);
  if (document === null) return c.notFound();
  await services.documents.accept(id);
  return c.redirect(`/dossier/letters/${id}?notice=Accepted.`, 303);
});

letterRoutes.post("/dossier/letters/:id/delete", async (c) => {
  const services = c.get("services");
  const id = c.req.param("id") ?? "";
  const document = await services.documents.get(id);
  if (document === null) return c.notFound();
  await services.documents.remove(id);
  const target = document.variantId !== null
    ? `/dossier/variants/${document.variantId}?notice=Draft+discarded.`
    : "/dossier/variants?notice=Draft+discarded.";
  return c.redirect(target, 303);
});
