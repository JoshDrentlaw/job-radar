/** @jsxImportSource hono/jsx */

/**
 * The skill profile (§7): long-form markdown in named facets, each embedded
 * separately so the corpus can be queried from different angles. Authored
 * here, embedded by the drain, matched against every posting chunk.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import {
  CheckboxField,
  CsrfField,
  Field,
  formatDateTime,
  Metric,
  Notice,
  Tabs,
} from "@web/components.tsx";
import { Markdown } from "@web/markdown.tsx";
import type { AppEnv } from "@web/types.ts";
import type { Services } from "@web/services.ts";
import { asFacetId, type FacetId } from "@platform/ids.ts";
import type { PostingId } from "@platform/ids.ts";
import type { ProfileFacet } from "@domain/discovery/matching.ts";
import { CHUNKER_VERSION, chunkText, DEFAULT_CHUNK_OPTIONS } from "@domain/discovery/chunk.ts";
import {
  DEFAULT_VOCABULARY_OPTIONS,
  findUncoveredDocuments,
  findVocabularyGaps,
  gapKind,
  type TermDocument,
  type UncoveredDocument,
  type VocabularyGap,
} from "@domain/discovery/vocabulary.ts";

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
            <button
              type="submit"
              class="quiet"
              formaction="/profile/facets/preview-chunks"
              formtarget="chunk-preview"
            >
              Preview chunking
            </button>
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

/**
 * Something to write about, picked at random from what the app already
 * tracks: a fact no facet reflects yet, and a term postings keep using that
 * appears in neither corpus. Either half is absent when there is nothing to
 * suggest, and the whole panel is absent when both are (§10's honest-limit
 * framing applies here too — this is a nudge, not a verdict).
 */
const WritingPrompt: FC<{
  fact: UncoveredDocument | undefined;
  term: VocabularyGap | undefined;
}> = ({ fact, term }) => (
  <section class="panel stack" id="prompts">
    <header>
      <h2>Something to write about</h2>
    </header>
    {fact !== undefined && (
      <div class="stack">
        <p>
          You wrote about this, but no facet covers it yet: <em>"{fact.label}"</em>
        </p>
        <div class="row">
          <a
            class="button quiet"
            href={`/profile?prefillContent=${encodeURIComponent(fact.label)}#new-content`}
          >
            Start a facet from this
          </a>
        </div>
      </div>
    )}
    {term !== undefined && (
      <div class="stack">
        <p>
          <strong>{term.term}</strong> shows up in {term.postingCount} posting
          {term.postingCount === 1 ? "" : "s"} you're not addressing —{" "}
          {term.examples.map((example, index) => (
            <span key={example.id}>
              {index > 0 ? ", " : ""}
              <a href={`/matches/${encodeURIComponent(example.id)}`}>{example.label}</a>
            </span>
          ))}
          . Have you done that?
        </p>
        <div class="row">
          <a
            class="button quiet"
            href={`/profile?prefillName=${encodeURIComponent(term.term)}#new-name`}
          >
            Start a facet named "{term.term}"
          </a>
        </div>
      </div>
    )}
    <p class="field-hint">
      Both are picked by word overlap, not meaning — treat them as a starting point, not a verdict.
    </p>
    <div class="row">
      <a class="button quiet" href="/profile#prompts">Another prompt</a>
    </div>
  </section>
);

const ProfilePage: FC<{
  facets: readonly ProfileFacet[];
  statuses: Map<FacetId, FacetStatus>;
  staleIds: ReadonlySet<string>;
  embedderConfigured: boolean;
  factPrompt: UncoveredDocument | undefined;
  termPrompt: VocabularyGap | undefined;
  csrfToken: string;
  error?: string;
  notice?: string;
  prefillName?: string;
  prefillContent?: string;
}> = (props) => (
  <Layout title="Profile" current="profile" csrfToken={props.csrfToken}>
    <Tabs
      label="Profile sections"
      items={[
        { href: "/profile", label: "Profile", current: true },
        { href: "/gaps", label: "Gaps" },
      ]}
    />
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

    {(props.factPrompt !== undefined || props.termPrompt !== undefined) && (
      <WritingPrompt fact={props.factPrompt} term={props.termPrompt} />
    )}

    {
      /*
      The form stays at the top and stays put. It used to sit below every
      facet, so the act of adding one pushed the way to add the next one
      further off the screen.
    */
    }
    <details
      class="panel disclosure"
      open={props.facets.length === 0 || props.prefillName !== undefined ||
        props.prefillContent !== undefined}
    >
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
              value={props.prefillName ?? ""}
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
            {props.prefillContent ?? ""}
          </textarea>
        </Field>
        <div class="row">
          <button type="submit" class="primary">Create facet</button>
          <button
            type="submit"
            class="quiet"
            formaction="/profile/facets/preview-chunks"
            formtarget="chunk-preview"
          >
            Preview chunking
          </button>
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

/**
 * A cheap, read-only look at how a facet's text will actually split for
 * embedding (§7) — no embedding call, no save, just `chunkText` run against
 * whatever was in the textarea when the button was pressed. Opens in a named
 * window (`formtarget` on the button, no JS involved) rather than navigating
 * away, so the in-progress edit in the original tab is never disturbed;
 * pressing "Preview chunking" again reuses that same window with the latest
 * text.
 */
const ChunkPreviewPage: FC<{ name: string; content: string; csrfToken: string }> = (props) => {
  const chunks = chunkText(props.content, DEFAULT_CHUNK_OPTIONS);
  return (
    <Layout title="Chunk preview" current="profile" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Chunk preview</h1>
          <p class="lede">
            {props.name !== ""
              ? `How "${props.name}" will split for embedding`
              : "How this text will split for embedding"}{" "}
            — each box below is one chunk, matched against postings independently. Nothing here is
            saved; edit the textarea and press "Preview chunking" again to refresh this window.
          </p>
        </div>
      </div>

      {props.content.trim() === ""
        ? <p class="empty">Nothing to preview — the text was empty.</p>
        : (
          <>
            <section class="panel">
              <div class="metrics">
                <Metric label="chunks" value={chunks.length} />
                <Metric label="characters" value={props.content.length} />
                <Metric
                  label="target / max chars"
                  value={`${DEFAULT_CHUNK_OPTIONS.targetChars} / ${DEFAULT_CHUNK_OPTIONS.maxChars}`}
                  hint="A chunk closes once it reaches the target. A single markdown block bigger than the max is hard-split, even mid-block."
                />
              </div>
              <p class="panel-note gap-above">
                Consecutive chunks overlap by one paragraph on purpose — the shared paragraph is
                what keeps a requirement straddling a boundary fully inside at least one chunk.
              </p>
            </section>

            {chunks.map((chunk, i) => (
              <section class="panel stack" key={chunk.seq}>
                <header>
                  <h2>
                    Chunk {i + 1} of {chunks.length}
                  </h2>
                  <span class="chip">{chunk.text.length} chars</span>
                </header>
                <pre class="chunk-preview-text">{chunk.text}</pre>
              </section>
            ))}
          </>
        )}
    </Layout>
  );
};

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

function pickOne<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(Math.random() * items.length)];
}

/**
 * The two prompt candidates (M12), reusing the Gaps machinery rather than
 * inventing a second way to compare facts, facets and postings. See
 * `docs/pages/profile.md` for why these two sources and not others.
 */
async function pickWritingPrompts(
  services: Services,
): Promise<{ factPrompt: UncoveredDocument | undefined; termPrompt: VocabularyGap | undefined }> {
  const [activeFacets, facts, candidates] = await Promise.all([
    services.facets.list().then((all) => all.filter((f) => f.active)),
    services.facts.list(),
    services.matches.listCandidates({}),
  ]);
  const profileText = activeFacets.map((f) => `${f.name}\n${f.content}`).join("\n");

  const activeFacts = facts.filter((f) => f.active);
  const factDocuments: TermDocument[] = activeFacts.map((f) => ({
    id: f.id,
    label: f.text,
    text: f.text,
  }));
  const factPrompt = pickOne(findUncoveredDocuments(factDocuments, profileText));

  const matched = new Set<PostingId>(candidates.map((candidate) => candidate.postingId));
  const { postings } = await services.postings.list({ limit: 5_000 });
  const scope = matched.size > 0 ? "matched" : "listed";
  const postingDocuments: TermDocument[] = postings
    .filter((posting) => scope === "listed" || matched.has(posting.id))
    .map((posting) => ({
      id: posting.id,
      label: posting.title,
      text: posting.descriptionText,
      groupId: posting.boardId,
    }));
  const dossierText = activeFacts
    .map((f) => `${f.text}\n${f.organization ?? ""}\n${f.tags.join("\n")}`)
    .join("\n");
  const report = findVocabularyGaps(postingDocuments, profileText, dossierText, {
    minPostings: DEFAULT_VOCABULARY_OPTIONS.minPostings,
  });
  const termPrompt = pickOne(report.gaps.filter((gap) => gapKind(gap) === "unknown-territory"));

  return { factPrompt, termPrompt };
}

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.get("/profile", async (c) => {
  const services = c.get("services");
  const model = services.embedder?.model;
  const [facets, statuses, staleFacets, prompts] = await Promise.all([
    services.facets.list(),
    model !== undefined
      ? services.chunks.facetEmbedStatus(model)
      : Promise.resolve(new Map<FacetId, FacetStatus>()),
    model !== undefined
      ? services.facets.staleForModel(model, CHUNKER_VERSION)
      : Promise.resolve([]),
    pickWritingPrompts(services),
  ]);

  const error = c.req.query("error");
  const notice = c.req.query("notice");
  const prefillName = c.req.query("prefillName");
  const prefillContent = c.req.query("prefillContent");
  return c.html(
    <ProfilePage
      facets={facets}
      statuses={statuses}
      staleIds={new Set(staleFacets.map((f) => f.id as string))}
      embedderConfigured={services.embedder !== null}
      factPrompt={prompts.factPrompt}
      termPrompt={prompts.termPrompt}
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
      {...(prefillName !== undefined ? { prefillName } : {})}
      {...(prefillContent !== undefined ? { prefillContent } : {})}
    />,
  );
});

// Not a facet mutation — reads whatever is currently in the textarea and
// shows how it would chunk. Nothing is persisted or embedded.
profileRoutes.post("/profile/facets/preview-chunks", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  return c.html(<ChunkPreviewPage name={name} content={content} csrfToken={c.get("csrfToken")} />);
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
