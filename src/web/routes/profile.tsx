/** @jsxImportSource hono/jsx */

/**
 * The skill profile (§7): long-form markdown in named facets, each embedded
 * separately so the corpus can be queried from different angles. Authored
 * here, embedded by the drain, matched against every posting chunk.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CheckboxField, CsrfField, Field, formatDateTime, Notice } from "@web/components.tsx";
import { Markdown } from "@web/markdown.tsx";
import type { AppEnv } from "@web/types.ts";
import { asFacetId, type FacetId } from "@platform/ids.ts";
import type { ProfileFacet } from "@domain/discovery/matching.ts";

function parseFacetId(raw: string): FacetId | null {
  try {
    return asFacetId(raw);
  } catch {
    return null;
  }
}

interface FacetStatus {
  readonly chunks: number;
  readonly embeddedAt: Date;
}

/**
 * The chip's colour and its words come from the same decision. They used to be
 * computed separately, which is how "not embedded yet" ended up wearing the
 * green that means "embedded".
 */
function embedStatus(
  facet: ProfileFacet,
  status: FacetStatus | undefined,
  stale: boolean,
): { label: string; tone: string } {
  if (!facet.active) return { label: "inactive", tone: "muted" };
  if (status === undefined) return { label: "not embedded yet", tone: "warn" };
  if (stale) return { label: "edited since last embed", tone: "warn" };
  return {
    label: `embedded · ${status.chunks} chunk${status.chunks === 1 ? "" : "s"}`,
    tone: "ok",
  };
}

/**
 * One facet, read first and edited second.
 *
 * The editor used to be the whole card, which made the page a stack of open
 * textareas — unreadable past about three facets, and it pushed the "new facet"
 * form further down every time one was added. Now the card shows what the facet
 * actually says, rendered, and the form is behind a disclosure.
 */
const FacetCard: FC<{
  facet: ProfileFacet;
  status: FacetStatus | undefined;
  stale: boolean;
  csrfToken: string;
}> = (props) => {
  const status = embedStatus(props.facet, props.status, props.stale);
  return (
    <section class="panel stack facet-card" id={`facet-${props.facet.id}`}>
      <header>
        <h2>{props.facet.name}</h2>
        <span class={`chip ${status.tone}`}>{status.label}</span>
      </header>
      {props.status !== undefined && (
        <p class="field-hint">
          Last embedded {formatDateTime(props.status.embeddedAt)}.{" "}
          {props.stale ? "Edits are not reflected in matches until the next refresh." : ""}
        </p>
      )}

      <Markdown text={props.facet.content} clamp />

      <details class="disclosure">
        <summary>Edit this facet</summary>
        <form method="post" action={`/profile/facets/${props.facet.id}`} class="stack">
          <CsrfField token={props.csrfToken} />
          <div class="field-row">
            <Field label="Name" for={`name-${props.facet.id}`}>
              <input
                id={`name-${props.facet.id}`}
                name="name"
                type="text"
                value={props.facet.name}
                required
                maxlength={80}
              />
            </Field>
            <CheckboxField
              name="active"
              id={`active-${props.facet.id}`}
              checked={props.facet.active}
              label="Active — embedded and matched"
            />
          </div>
          <Field
            wide
            label="Profile text (markdown)"
            for={`content-${props.facet.id}`}
            hint="Headings, lists, emphasis and links render above once saved."
          >
            <textarea
              id={`content-${props.facet.id}`}
              name="content"
              class="editor"
              rows={16}
              required
            >
              {props.facet.content}
            </textarea>
          </Field>
          <div class="row">
            <button type="submit" class="primary">Save facet</button>
          </div>
        </form>
        <form
          method="post"
          action={`/profile/facets/${props.facet.id}/delete`}
          class="inline-form gap-above"
        >
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="quiet danger-text">
            Delete facet (removes its matches)
          </button>
        </form>
      </details>
    </section>
  );
};

const ProfilePage: FC<{
  facets: readonly ProfileFacet[];
  statuses: Map<FacetId, FacetStatus>;
  staleIds: ReadonlySet<string>;
  embedderConfigured: boolean;
  csrfToken: string;
  error?: string;
  notice?: string;
}> = (props) => (
  <Layout title="Profile" current="profile" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>Skill profile</h1>
        <p class="lede">
          Long-form descriptions of what you have actually done, in your own words. Each facet is a
          separate angle — postings are matched against every active facet, and a match cites which
          one it hit.
        </p>
      </div>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
    {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}
    {!props.embedderConfigured && (
      <Notice kind="warn">
        No embedding API key is configured (VOYAGE_API_KEY), so facets can be authored but not
        embedded or matched.
      </Notice>
    )}

    {
      /*
      The form stays at the top and stays put. It used to sit below every
      facet, so the act of adding one pushed the way to add the next one
      further off the screen.
    */
    }
    <details class="panel disclosure" open={props.facets.length === 0}>
      <summary>Add a facet</summary>
      <p class="panel-note">
        A facet is one angle on the same experience, not a category of job. Two facets that would
        match the same postings are better written as one.
      </p>
      <form method="post" action="/profile/facets" class="stack gap-above">
        <CsrfField token={props.csrfToken} />
        <div class="field-row">
          <Field label="Name" for="new-name" hint="Short — it is what a match cites.">
            <input
              id="new-name"
              name="name"
              type="text"
              required
              maxlength={80}
              placeholder="backend"
            />
          </Field>
        </div>
        <Field
          wide
          label="Profile text (markdown)"
          for="new-content"
          hint="Markdown renders on the card once saved."
        >
          <textarea
            id="new-content"
            name="content"
            class="editor"
            rows={12}
            required
            placeholder="What you have built, operated, debugged — specifics beat titles."
          >
          </textarea>
        </Field>
        <div class="row">
          <button type="submit" class="primary">Create facet</button>
        </div>
      </form>
    </details>

    {props.facets.length === 0
      ? (
        <p class="empty">
          No facets yet. Write the first one above — for example "backend", "full-stack" or
          "data-pipeline" — as prose about work you have done.
        </p>
      )
      : (
        <>
          {props.facets.length > 1 && (
            <nav class="panel facet-index" aria-label="Facets">
              <ul class="tag-list">
                {props.facets.map((facet) => (
                  <li key={facet.id}>
                    <a
                      class={`chip ${facet.active ? "accent" : "muted"}`}
                      href={`#facet-${facet.id}`}
                    >
                      {facet.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {props.facets.map((facet) => (
            <FacetCard
              facet={facet}
              status={props.statuses.get(facet.id)}
              stale={props.staleIds.has(facet.id)}
              csrfToken={props.csrfToken}
            />
          ))}
        </>
      )}
  </Layout>
);

function formValues(body: Record<string, unknown>): {
  name: string;
  content: string;
  active: boolean;
} {
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    content: typeof body.content === "string" ? body.content.trim() : "",
    active: body.active !== undefined,
  };
}

/** Postgres unique_violation on profile_facets.name. */
function isDuplicateName(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: string }).code === "23505";
}

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.get("/profile", async (c) => {
  const services = c.get("services");
  const model = services.embedder?.model;
  const [facets, statuses, staleFacets] = await Promise.all([
    services.facets.list(),
    model !== undefined
      ? services.chunks.facetEmbedStatus(model)
      : Promise.resolve(new Map<FacetId, FacetStatus>()),
    model !== undefined ? services.facets.staleForModel(model) : Promise.resolve([]),
  ]);

  const error = c.req.query("error");
  const notice = c.req.query("notice");
  return c.html(
    <ProfilePage
      facets={facets}
      statuses={statuses}
      staleIds={new Set(staleFacets.map((f) => f.id as string))}
      embedderConfigured={services.embedder !== null}
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

profileRoutes.post("/profile/facets", async (c) => {
  const { name, content } = formValues(await c.req.parseBody());
  if (name === "" || content === "") {
    return c.redirect(`/profile?error=${encodeURIComponent("Name and text are required.")}`, 303);
  }
  try {
    await c.get("services").facets.upsert({ name, content });
  } catch (error) {
    if (isDuplicateName(error)) {
      return c.redirect(
        `/profile?error=${encodeURIComponent(`A facet named "${name}" already exists.`)}`,
        303,
      );
    }
    throw error;
  }
  return c.redirect(
    `/profile?notice=${encodeURIComponent(`Created "${name}". It embeds on the next refresh.`)}`,
    303,
  );
});

profileRoutes.post("/profile/facets/:id", async (c) => {
  const id = parseFacetId(c.req.param("id"));
  if (id === null) return c.notFound();
  const services = c.get("services");
  const existing = await services.facets.get(id);
  if (existing === null) return c.notFound();

  const { name, content, active } = formValues(await c.req.parseBody());
  if (name === "" || content === "") {
    return c.redirect(`/profile?error=${encodeURIComponent("Name and text are required.")}`, 303);
  }
  try {
    await services.facets.upsert({ id, name, content, active });
  } catch (error) {
    if (isDuplicateName(error)) {
      return c.redirect(
        `/profile?error=${encodeURIComponent(`A facet named "${name}" already exists.`)}`,
        303,
      );
    }
    throw error;
  }
  return c.redirect(`/profile?notice=${encodeURIComponent(`Saved "${name}".`)}`, 303);
});

profileRoutes.post("/profile/facets/:id/delete", async (c) => {
  const id = parseFacetId(c.req.param("id"));
  if (id === null) return c.notFound();
  await c.get("services").facets.remove(id);
  return c.redirect("/profile?notice=Facet+deleted.", 303);
});
