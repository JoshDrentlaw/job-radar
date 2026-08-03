/** @jsxImportSource hono/jsx */

/**
 * The fact set (§8): the canonical, true statements every generated document
 * is built from. Facts are retired, never silently deleted — a fact cited by
 * any variant refuses deletion outright — and new truth enters here,
 * deliberately, by the user. No model writes to this page, in any milestone.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDate, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { asFactId, type FactId } from "@platform/ids.ts";
import {
  FACT_KINDS,
  type FactInput,
  FactInUseError,
  type FactKind,
  type Identity,
  IDENTITY_SETTING,
  isFactKind,
  PARENT_KINDS,
  type ResumeFact,
} from "@domain/dossier/types.ts";

function parseFactId(raw: string): FactId | null {
  try {
    return asFactId(raw);
  } catch {
    return null;
  }
}

/** "2023-04" (a month input) → UTC first-of-month, or undefined. */
function parseMonth(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function monthValue(date: Date | undefined): string {
  return date === undefined ? "" : date.toISOString().slice(0, 7);
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
}

const KIND_LABELS: Record<FactKind, string> = {
  summary: "Summary",
  role: "Roles",
  bullet: "Bullets",
  skill: "Skills",
  education: "Education",
  project: "Projects",
  narrative: "Narrative (cover letters only)",
};

const FactForm: FC<{
  action: string;
  fact?: ResumeFact;
  parents: readonly ResumeFact[];
  csrfToken: string;
  submitLabel: string;
}> = (props) => (
  <form method="post" action={props.action} class="stack">
    <CsrfField token={props.csrfToken} />
    <div class="field-row">
      <div>
        <label>Kind</label>
        <select name="kind">
          {FACT_KINDS.map((kind) => (
            <option value={kind} selected={props.fact?.kind === kind}>{kind}</option>
          ))}
        </select>
      </div>
      <div>
        <label>Parent (bullets only)</label>
        <select name="parent_id">
          <option value="">—</option>
          {props.parents.map((parent) => (
            <option value={parent.id} selected={props.fact?.parentId === parent.id}>
              {parent.text.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
    </div>
    <div>
      <label>Text — the canonical, true statement</label>
      <textarea name="text" rows={3} required>{props.fact?.text ?? ""}</textarea>
    </div>
    <div class="field-row">
      <div>
        <label>Organization</label>
        <input type="text" name="organization" value={props.fact?.organization ?? ""} />
      </div>
      <div>
        <label>Tags (comma-separated)</label>
        <input type="text" name="tags" value={props.fact?.tags.join(", ") ?? ""} />
      </div>
    </div>
    <div class="field-row">
      <div>
        <label>Start</label>
        <input type="month" name="start_date" value={monthValue(props.fact?.startDate)} />
      </div>
      <div>
        <label>End (blank = present)</label>
        <input type="month" name="end_date" value={monthValue(props.fact?.endDate)} />
      </div>
    </div>
    <div class="row">
      <button type="submit" class="primary">{props.submitLabel}</button>
    </div>
  </form>
);

const FactRow: FC<{
  fact: ResumeFact;
  parents: readonly ResumeFact[];
  indent: boolean;
  csrfToken: string;
}> = ({ fact, parents, indent, csrfToken }) => (
  <div class={`fact-row${indent ? " fact-indent" : ""}${fact.active ? "" : " fact-retired"}`}>
    <div class="fact-main">
      <p class="fact-text">{fact.text}</p>
      <p class="meta-line">
        {fact.organization !== undefined && <span>{fact.organization}</span>}
        {(fact.startDate !== undefined || fact.endDate !== undefined) && (
          <span>
            {formatDate(fact.startDate)} →{" "}
            {fact.endDate === undefined ? "present" : formatDate(fact.endDate)}
          </span>
        )}
        {fact.tags.length > 0 && <span class="field-hint">{fact.tags.join(", ")}</span>}
        {!fact.active && <span class="chip muted">retired</span>}
      </p>
    </div>
    <div class="fact-actions">
      <form method="post" action={`/dossier/facts/${fact.id}/move`} class="inline-form">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="direction" value="up" />
        <button type="submit" class="quiet" title="Move up">↑</button>
      </form>
      <form method="post" action={`/dossier/facts/${fact.id}/move`} class="inline-form">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="direction" value="down" />
        <button type="submit" class="quiet" title="Move down">↓</button>
      </form>
      <details class="fact-edit">
        <summary class="button quiet">Edit</summary>
        <div class="fact-edit-body">
          <FactForm
            action={`/dossier/facts/${fact.id}`}
            fact={fact}
            parents={parents}
            csrfToken={csrfToken}
            submitLabel="Save fact"
          />
          <div class="row gap-above-tight">
            <form
              method="post"
              action={`/dossier/facts/${fact.id}/${fact.active ? "retire" : "activate"}`}
              class="inline-form"
            >
              <CsrfField token={csrfToken} />
              <button type="submit" class="quiet">
                {fact.active ? "Retire" : "Reactivate"}
              </button>
            </form>
            <form method="post" action={`/dossier/facts/${fact.id}/delete`} class="inline-form">
              <CsrfField token={csrfToken} />
              <button type="submit" class="quiet danger-text">Delete</button>
            </form>
          </div>
        </div>
      </details>
    </div>
  </div>
);

const DossierPage: FC<{
  facts: readonly ResumeFact[];
  identity: Identity | null;
  csrfToken: string;
  error?: string;
  notice?: string;
}> = (props) => {
  const parents = props.facts.filter((f) => PARENT_KINDS.has(f.kind));
  const childrenOf = (id: FactId) => props.facts.filter((f) => f.parentId === id);
  const topLevel = (kind: FactKind) =>
    props.facts.filter((f) => f.kind === kind && f.parentId === undefined);
  const orphanBullets = props.facts.filter(
    (f) =>
      f.kind === "bullet" &&
      (f.parentId === undefined || !props.facts.some((p) => p.id === f.parentId)),
  );

  return (
    <Layout title="Dossier" current="dossier" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Fact set</h1>
          <p class="lede">
            Every generated document is rendered from these statements. Tailoring reorders, selects
            and rewords them — it never invents. New truth is added here, by you.
          </p>
        </div>
        <a class="button quiet" href="/dossier/variants">Variants →</a>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      <section class="panel stack">
        <header>
          <h2>Identity</h2>
        </header>
        <p class="panel-note">
          The rendered header. Not facts — contact details for the top of the page.
        </p>
        <form method="post" action="/dossier/identity" class="stack">
          <CsrfField token={props.csrfToken} />
          <div class="field-row">
            <div>
              <label>Name</label>
              <input type="text" name="name" value={props.identity?.name ?? ""} required />
            </div>
            <div>
              <label>Email</label>
              <input type="text" name="email" value={props.identity?.email ?? ""} />
            </div>
          </div>
          <div class="field-row">
            <div>
              <label>Phone</label>
              <input type="text" name="phone" value={props.identity?.phone ?? ""} />
            </div>
            <div>
              <label>Location</label>
              <input type="text" name="location" value={props.identity?.location ?? ""} />
            </div>
          </div>
          <div>
            <label>Links (one per line)</label>
            <textarea name="links" rows={2}>{props.identity?.links.join("\n") ?? ""}</textarea>
          </div>
          <div class="row">
            <button type="submit" class="primary">Save identity</button>
          </div>
        </form>
      </section>

      {(["summary", "role", "project", "education", "skill"] as const).map((kind) => (
        <section class="panel">
          <header>
            <h2>{KIND_LABELS[kind]}</h2>
          </header>
          {topLevel(kind).length === 0
            ? <p class="empty">None yet.</p>
            : topLevel(kind).map((fact) => (
              <div key={fact.id} class="fact-group">
                <FactRow
                  fact={fact}
                  parents={parents}
                  indent={false}
                  csrfToken={props.csrfToken}
                />
                {childrenOf(fact.id).map((bullet) => (
                  <FactRow
                    key={bullet.id}
                    fact={bullet}
                    parents={parents}
                    indent
                    csrfToken={props.csrfToken}
                  />
                ))}
              </div>
            ))}
        </section>
      ))}

      {orphanBullets.length > 0 && (
        <section class="panel">
          <header>
            <h2>Bullets without a parent</h2>
          </header>
          <p class="panel-note">
            A bullet renders only under its role or project. Edit these to give them one.
          </p>
          {orphanBullets.map((fact) => (
            <FactRow fact={fact} parents={parents} indent={false} csrfToken={props.csrfToken} />
          ))}
        </section>
      )}

      <section class="panel stack">
        <header>
          <h2>Add a fact</h2>
        </header>
        <FactForm
          action="/dossier/facts"
          parents={parents}
          csrfToken={props.csrfToken}
          submitLabel="Add fact"
        />
      </section>
    </Layout>
  );
};

function factInputFrom(body: Record<string, unknown>): FactInput | string {
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!isFactKind(kind)) return `Unknown fact kind: ${kind}`;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") return "Text is required.";

  const parentRaw = typeof body.parent_id === "string" ? body.parent_id : "";
  let parentId: FactId | undefined;
  if (kind === "bullet") {
    if (parentRaw === "") return "A bullet needs a parent role or project.";
    const parsed = parseFactId(parentRaw);
    if (parsed === null) return "Malformed parent id.";
    parentId = parsed;
  }

  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  const startDate = parseMonth(body.start_date);
  const endDate = parseMonth(body.end_date);
  if (startDate !== undefined && endDate !== undefined && endDate < startDate) {
    return "End date is before start date.";
  }

  return {
    kind,
    text,
    tags: parseTags(body.tags),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(organization !== "" ? { organization } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
  };
}

export const dossierRoutes = new Hono<AppEnv>();

dossierRoutes.get("/dossier", async (c) => {
  const services = c.get("services");
  const [facts, identity] = await Promise.all([
    services.facts.list(),
    services.settings.get<Identity>(IDENTITY_SETTING),
  ]);
  const error = c.req.query("error");
  const notice = c.req.query("notice");
  return c.html(
    <DossierPage
      facts={facts}
      identity={identity}
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

dossierRoutes.post("/dossier/identity", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") {
    return c.redirect(`/dossier?error=${encodeURIComponent("Name is required.")}`, 303);
  }
  const field = (key: string) => {
    const value = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    return value === "" ? undefined : value;
  };
  const links = typeof body.links === "string"
    ? body.links.split("\n").map((l) => l.trim()).filter((l) => l !== "")
    : [];
  const identity: Identity = {
    name,
    links,
    ...(field("email") !== undefined ? { email: field("email")! } : {}),
    ...(field("phone") !== undefined ? { phone: field("phone")! } : {}),
    ...(field("location") !== undefined ? { location: field("location")! } : {}),
  };
  await c.get("services").settings.set(IDENTITY_SETTING, identity);
  return c.redirect("/dossier?notice=Identity+saved.", 303);
});

dossierRoutes.post("/dossier/facts", async (c) => {
  const input = factInputFrom(await c.req.parseBody());
  if (typeof input === "string") {
    return c.redirect(`/dossier?error=${encodeURIComponent(input)}`, 303);
  }
  await c.get("services").facts.create(input);
  return c.redirect("/dossier?notice=Fact+added.", 303);
});

dossierRoutes.post("/dossier/facts/:id", async (c) => {
  const id = parseFactId(c.req.param("id"));
  if (id === null) return c.notFound();
  const input = factInputFrom(await c.req.parseBody());
  if (typeof input === "string") {
    return c.redirect(`/dossier?error=${encodeURIComponent(input)}`, 303);
  }
  const updated = await c.get("services").facts.update(id, input);
  if (updated === null) return c.notFound();
  return c.redirect("/dossier?notice=Fact+saved.", 303);
});

dossierRoutes.post("/dossier/facts/:id/move", async (c) => {
  const id = parseFactId(c.req.param("id"));
  if (id === null) return c.notFound();
  const body = await c.req.parseBody();
  const direction = body.direction === "up" ? "up" : "down";
  await c.get("services").facts.move(id, direction);
  return c.redirect("/dossier", 303);
});

dossierRoutes.post("/dossier/facts/:id/retire", async (c) => {
  const id = parseFactId(c.req.param("id"));
  if (id === null) return c.notFound();
  await c.get("services").facts.setActive(id, false);
  return c.redirect(
    "/dossier?notice=Fact+retired.+Variants+that+cite+it+still+resolve+it.",
    303,
  );
});

dossierRoutes.post("/dossier/facts/:id/activate", async (c) => {
  const id = parseFactId(c.req.param("id"));
  if (id === null) return c.notFound();
  await c.get("services").facts.setActive(id, true);
  return c.redirect("/dossier?notice=Fact+reactivated.", 303);
});

dossierRoutes.post("/dossier/facts/:id/delete", async (c) => {
  const id = parseFactId(c.req.param("id"));
  if (id === null) return c.notFound();
  try {
    await c.get("services").facts.remove(id);
  } catch (error) {
    if (error instanceof FactInUseError) {
      return c.redirect(`/dossier?error=${encodeURIComponent(error.message)}`, 303);
    }
    throw error;
  }
  return c.redirect("/dossier?notice=Fact+deleted.", 303);
});
