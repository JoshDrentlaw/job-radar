/** @jsxImportSource hono/jsx */

/**
 * Application tracking (§9).
 *
 * "The UI's job here is to make the annoying parts near-zero effort: one click
 * from a match to a pre-populated draft, generated variant, clipboard-ready
 * fields, the apply URL, and a checklist. The human clicks through the
 * company's form. The app remembers everything else."
 *
 * Nothing here submits anything anywhere (§2). The apply link opens the
 * company's own form in a new tab; every field the form is likely to ask for is
 * laid out for copying; the checklist is state the app keeps so the user does
 * not have to hold it in their head.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDateTime, Notice, relativeAge } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { type ApplicationId, asApplicationId, asPostingId, asVariantId } from "@platform/ids.ts";
import {
  type Application,
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type ApplicationSummary,
  DuplicateApplicationError,
  isApplicationStatus,
  TERMINAL_STATUSES,
} from "@domain/pipeline/types.ts";
import {
  type Identity,
  IDENTITY_SETTING,
  VariantFrozenError,
  type VariantSummary,
} from "@domain/dossier/types.ts";

function parseId(raw: string): ApplicationId | null {
  try {
    return asApplicationId(raw);
  } catch {
    return null;
  }
}

const STATUS_CLASS: Record<ApplicationStatus, string> = {
  drafting: "muted",
  sent: "ok",
  acknowledged: "ok",
  screening: "ok",
  interviewing: "ok",
  offer: "ok",
  rejected: "danger",
  ghosted: "warn",
  withdrawn: "muted",
};

const ListPage: FC<{
  applications: readonly ApplicationSummary[];
  counts: Map<ApplicationStatus, number>;
  includeClosed: boolean;
  csrfToken: string;
  now: Date;
  notice?: string;
  error?: string;
}> = (props) => (
  <Layout title="Applications" current="applications" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>Applications</h1>
        <p class="lede">
          What was sent where, with which variant, and what happened since. This app never submits
          anything — it remembers.
        </p>
      </div>
      <a
        class="button quiet"
        href={props.includeClosed ? "/applications" : "/applications?closed=1"}
      >
        {props.includeClosed ? "Hide closed" : "Show closed"}
      </a>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
    {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

    <section class="panel">
      <header>
        <h2>By status</h2>
      </header>
      <div class="metrics">
        {APPLICATION_STATUSES.filter((s) => (props.counts.get(s) ?? 0) > 0).map((status) => (
          <div class="metric" key={status}>
            <div class="metric-value">{props.counts.get(status) ?? 0}</div>
            <div class="metric-label">{status}</div>
          </div>
        ))}
        {props.counts.size === 0 && <p class="empty">Nothing tracked yet.</p>}
      </div>
    </section>

    <section class="panel">
      <header>
        <h2>{props.includeClosed ? "All applications" : "Open applications"}</h2>
      </header>
      {props.applications.length === 0
        ? (
          <p class="empty">
            None yet. Start one from a match — <a href="/matches">browse matches</a>.
          </p>
        )
        : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {props.applications.map((application) => (
                  <tr key={application.id}>
                    <td>
                      <a class="posting-title" href={`/applications/${application.id}`}>
                        {application.postingTitle}
                      </a>
                    </td>
                    <td>{application.companyName}</td>
                    <td>
                      <span class={`chip ${STATUS_CLASS[application.status]}`}>
                        {application.status}
                      </span>
                    </td>
                    <td title={formatDateTime(application.lastActivityAt)}>
                      {relativeAge(application.lastActivityAt, props.now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  </Layout>
);

/** A value laid out for copying into someone else's form. */
const CopyField: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div class="copy-field">
    <span class="copy-label">{label}</span>
    <input type="text" readonly value={value} class="copy-value" />
  </div>
);

const DetailPage: FC<{
  application: Application;
  identity: Identity | null;
  variantName: string | null;
  csrfToken: string;
  now: Date;
  notice?: string;
  error?: string;
}> = (props) => {
  const a = props.application;
  const closed = TERMINAL_STATUSES.has(a.status);

  return (
    <Layout title={a.postingTitle} current="applications" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>{a.postingTitle}</h1>
          <p class="meta-line">
            <span>{a.companyName}</span>
            <span class={`chip ${STATUS_CLASS[a.status]}`}>{a.status}</span>
            {a.sentAt !== undefined && <span>sent {relativeAge(a.sentAt, props.now)}</span>}
          </p>
        </div>
        <div class="row">
          <a class="button primary" href={a.applyUrl} rel="noreferrer noopener" target="_blank">
            Open the company's form ↗
          </a>
        </div>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      {a.status === "ghosted" && (
        <Notice kind="warn">
          No activity for a while, so this was marked ghosted by the sweep. That means silence and
          nothing else — not that you were passed over. Logging any activity moves it back.
        </Notice>
      )}

      <section class="panel">
        <header>
          <h2>Ready to paste</h2>
        </header>
        <p class="panel-note">
          The fields their form will ask for. Nothing is submitted from here — you fill in their
          form, and this page remembers what you used.
        </p>
        <div class="copy-grid gap-above">
          {props.identity !== null && (
            <>
              <CopyField label="Name" value={props.identity.name} />
              {props.identity.email !== undefined && (
                <CopyField label="Email" value={props.identity.email} />
              )}
              {props.identity.phone !== undefined && (
                <CopyField label="Phone" value={props.identity.phone} />
              )}
              {props.identity.location !== undefined && (
                <CopyField label="Location" value={props.identity.location} />
              )}
              {props.identity.links.map((link) => (
                <CopyField key={link} label="Link" value={link} />
              ))}
            </>
          )}
          <CopyField label="Apply URL" value={a.applyUrl} />
        </div>
        {props.identity === null && (
          <Notice kind="warn">
            No identity is set, so there is nothing to paste.{" "}
            <a href="/dossier">Set it on the fact set page.</a>
          </Notice>
        )}
      </section>

      <section class="panel">
        <header>
          <h2>Documents</h2>
        </header>
        <p class="field-hint">
          The variant is frozen, so what renders today is byte-identical to what was sent.
        </p>
        <div class="row gap-above-tight">
          <a class="button quiet" href={`/dossier/variants/${a.variantId}/resume.pdf`}>
            Resume PDF
          </a>
          <a class="button quiet" href={`/dossier/variants/${a.variantId}/resume.docx`}>
            Resume DOCX
          </a>
          {a.coverLetterId !== undefined && (
            <a class="button quiet" href={`/dossier/letters/${a.coverLetterId}`}>Cover letter</a>
          )}
          <a class="button quiet" href={`/dossier/variants/${a.variantId}`}>
            {props.variantName ?? "Variant"}
          </a>
        </div>
      </section>

      {!closed && (
        <section class="panel stack">
          <header>
            <h2>Where is it now?</h2>
          </header>
          <form method="post" action={`/applications/${a.id}/status`} class="row">
            <CsrfField token={props.csrfToken} />
            <select name="status">
              {APPLICATION_STATUSES.filter((s) => s !== a.status && s !== "ghosted").map((s) => (
                <option value={s} key={s}>{s}</option>
              ))}
            </select>
            <input type="text" name="detail" placeholder="What happened? (optional)" />
            <button type="submit" class="primary">Record</button>
          </form>
          <p class="field-hint">
            `ghosted` is not in this list on purpose — it is set by the sweep when nothing has
            happened for a while, and choosing it by hand would be recording an inference rather
            than an observation.
          </p>
        </section>
      )}

      <section class="panel stack">
        <header>
          <h2>Log something</h2>
        </header>
        <form method="post" action={`/applications/${a.id}/events`} class="row">
          <CsrfField token={props.csrfToken} />
          <input
            type="text"
            name="detail"
            placeholder="Recruiter emailed, phone screen booked, …"
            required
          />
          <button type="submit" class="quiet">Add to timeline</button>
        </form>
      </section>

      <section class="panel stack">
        <header>
          <h2>Notes</h2>
        </header>
        <form method="post" action={`/applications/${a.id}/notes`} class="stack">
          <CsrfField token={props.csrfToken} />
          <textarea name="notes" rows={5} class="editor">{a.notes}</textarea>
          <div class="row">
            <button type="submit" class="quiet">Save notes</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <header>
          <h2>Timeline</h2>
        </header>
        <ol class="timeline">
          {a.events.map((event) => (
            <li key={event.id}>
              <div class="meta-line">
                <span class="chip">{event.kind.replace("_", " ")}</span>
                {event.source === "rule" && <span class="chip warn">set by rule</span>}
                <span title={formatDateTime(event.at)}>{relativeAge(event.at, props.now)}</span>
              </div>
              {event.toStatus !== null && (
                <p class="fact-text">
                  {event.fromStatus !== null ? `${event.fromStatus} → ` : ""}
                  {event.toStatus}
                </p>
              )}
              {event.detail !== "" && <p class="field-hint">{event.detail}</p>}
            </li>
          ))}
        </ol>
      </section>

      <section class="panel">
        <header>
          <h2>Remove</h2>
        </header>
        <p class="panel-note">
          Deleting discards the timeline with it. Withdrawing keeps the record and is usually what
          you want.
        </p>
        <form method="post" action={`/applications/${a.id}/delete`} class="inline-form gap-above">
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="quiet danger-text">Delete this record</button>
        </form>
      </section>
    </Layout>
  );
};

/** Start an application from a match: pick the frozen variant, go. */
const StartPage: FC<{
  postingId: string;
  postingTitle: string;
  companyName: string;
  variants: readonly VariantSummary[];
  csrfToken: string;
  error?: string;
}> = (props) => (
  <Layout title="Start an application" current="applications" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>Start an application</h1>
        <p class="lede">
          {props.postingTitle} at {props.companyName}
        </p>
      </div>
      <a class="button quiet" href={`/matches/${encodeURIComponent(props.postingId)}`}>← Match</a>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}

    <section class="panel stack">
      <header>
        <h2>Which variant did you send?</h2>
      </header>
      <p class="panel-note">
        The variant is frozen when the application is created, so the resume this record points at
        stays byte-identical to the one that went out (§9).
      </p>
      {props.variants.length === 0
        ? (
          <p class="empty">
            No variants yet. <a href="/dossier/variants">Create one first.</a>
          </p>
        )
        : (
          <form method="post" action="/applications" class="stack">
            <CsrfField token={props.csrfToken} />
            <input type="hidden" name="posting_id" value={props.postingId} />
            <div>
              <label for="variant">Variant</label>
              <select id="variant" name="variant_id">
                {props.variants.map((variant) => (
                  <option value={variant.id} key={variant.id}>
                    {variant.name}
                    {variant.frozen ? " (frozen)" : ""} · {variant.factCount} facts
                  </option>
                ))}
              </select>
            </div>
            <div class="row">
              <button type="submit" class="primary">Start tracking</button>
            </div>
          </form>
        )}
    </section>
  </Layout>
);

export const applicationRoutes = new Hono<AppEnv>();

applicationRoutes.get("/applications", async (c) => {
  const services = c.get("services");
  const includeClosed = c.req.query("closed") !== undefined;
  const [applications, counts] = await Promise.all([
    services.applications.list({ includeClosed }),
    services.applications.countByStatus(),
  ]);
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <ListPage
      applications={applications}
      counts={counts}
      includeClosed={includeClosed}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

/** One click from a match (§9). */
applicationRoutes.get("/applications/new", async (c) => {
  const services = c.get("services");
  const raw = c.req.query("posting") ?? "";
  let postingId;
  try {
    postingId = asPostingId(raw);
  } catch {
    return c.notFound();
  }
  const posting = await services.postings.get(postingId);
  if (posting === null) return c.notFound();
  const [board, variants] = await Promise.all([
    services.boards.get(posting.boardId),
    services.variants.list(),
  ]);
  const error = c.req.query("error");
  return c.html(
    <StartPage
      postingId={postingId}
      postingTitle={posting.title}
      companyName={board?.companyName ?? posting.boardId}
      variants={variants}
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

applicationRoutes.post("/applications", async (c) => {
  const services = c.get("services");
  const body = await c.req.parseBody();
  const rawPosting = typeof body.posting_id === "string" ? body.posting_id : "";
  const rawVariant = typeof body.variant_id === "string" ? body.variant_id : "";

  const fail = (message: string) =>
    c.redirect(
      `/applications/new?posting=${encodeURIComponent(rawPosting)}&error=${
        encodeURIComponent(message)
      }`,
      303,
    );

  let postingId, variantId;
  try {
    postingId = asPostingId(rawPosting);
    variantId = asVariantId(rawVariant);
  } catch {
    return fail("Pick a variant to send.");
  }

  const [posting, variant] = await Promise.all([
    services.postings.get(postingId),
    services.variants.get(variantId),
  ]);
  if (posting === null || variant === null) return c.notFound();
  const board = await services.boards.get(posting.boardId);

  // Freeze at send time (§9) so the document this record points at cannot
  // drift out from under it.
  if (!variant.frozen) {
    try {
      await services.variants.freeze(variantId);
    } catch (error) {
      if (error instanceof VariantFrozenError) { /* already frozen; fine */ }
      else throw error;
    }
  }

  try {
    const application = await services.applications.create({
      postingId,
      variantId,
      postingTitle: posting.title,
      companyName: board?.companyName ?? posting.boardId,
      applyUrl: posting.applyUrl,
    });
    return c.redirect(`/applications/${application.id}`, 303);
  } catch (error) {
    if (error instanceof DuplicateApplicationError) return fail(error.message);
    throw error;
  }
});

applicationRoutes.get("/applications/:id", async (c) => {
  const id = parseId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const application = await services.applications.get(id);
  if (application === null) return c.notFound();

  const [identity, variant] = await Promise.all([
    services.settings.get<Identity>(IDENTITY_SETTING),
    services.variants.get(application.variantId),
  ]);
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <DetailPage
      application={application}
      identity={identity}
      variantName={variant?.name ?? null}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

applicationRoutes.post("/applications/:id/status", async (c) => {
  const id = parseId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const body = await c.req.parseBody();
  const status = typeof body.status === "string" ? body.status : "";
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";

  if (!isApplicationStatus(status)) {
    return c.redirect(`/applications/${id}?error=Unknown+status.`, 303);
  }
  if (status === "ghosted") {
    return c.redirect(
      `/applications/${id}?error=${
        encodeURIComponent(
          "`ghosted` is set by the sweep from elapsed silence, not chosen by hand.",
        )
      }`,
      303,
    );
  }
  await services.applications.changeStatus(id, status, {
    at: services.clock.now(),
    ...(detail !== "" ? { detail } : {}),
  });
  return c.redirect(`/applications/${id}?notice=Recorded.`, 303);
});

applicationRoutes.post("/applications/:id/events", async (c) => {
  const id = parseId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const body = await c.req.parseBody();
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  if (detail === "") return c.redirect(`/applications/${id}?error=Say+what+happened.`, 303);
  await services.applications.addEvent(id, detail, services.clock.now());
  return c.redirect(`/applications/${id}?notice=Logged.`, 303);
});

applicationRoutes.post("/applications/:id/notes", async (c) => {
  const id = parseId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  const services = c.get("services");
  const body = await c.req.parseBody();
  const notes = typeof body.notes === "string" ? body.notes : "";
  await services.applications.setNotes(id, notes, services.clock.now());
  return c.redirect(`/applications/${id}?notice=Notes+saved.`, 303);
});

applicationRoutes.post("/applications/:id/delete", async (c) => {
  const id = parseId(c.req.param("id") ?? "");
  if (id === null) return c.notFound();
  await c.get("services").applications.remove(id);
  return c.redirect("/applications?notice=Record+deleted.", 303);
});
