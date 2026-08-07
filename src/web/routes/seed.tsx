/** @jsxImportSource hono/jsx */

/**
 * Seed the dossier from a pasted resume (M11): the copy-paste this app is
 * meant to remove. Extraction happens in `@domain/dossier/seed.ts`; this file
 * is only the paste form, the review table, and the create handler.
 *
 * The fact set's own rule still holds: "no model writes to this page, in any
 * milestone." Extraction produces candidates, rendered here pre-filled and
 * editable — exactly the fields the manual "Add a fact" form uses — and
 * nothing reaches `FactRepo.create` until this page's own submit, same as
 * accepting a tailoring proposal is the only path into a variant.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CheckboxField, CsrfField, Field, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { FactId } from "@platform/ids.ts";
import {
  FACT_KINDS,
  type FactKind,
  type Identity,
  IDENTITY_SETTING,
  isFactKind,
} from "@domain/dossier/types.ts";
import {
  buildSeedRequest,
  MalformedSeedError,
  parseSeedResponse,
  type SeedFact,
  type SeedIdentity,
} from "@domain/dossier/seed.ts";
import { LlmRefusalError, LlmTruncatedError } from "@domain/llm.ts";

const KIND_LABELS: Record<FactKind, string> = {
  summary: "Summary",
  role: "Role",
  bullet: "Bullet",
  skill: "Skill",
  education: "Education",
  project: "Project",
  narrative: "Narrative",
};

function monthValue(date: Date | undefined): string {
  return date === undefined ? "" : date.toISOString().slice(0, 7);
}

/** Turn a domain failure into a message worth reading. */
function explain(error: unknown): string | null {
  if (error instanceof MalformedSeedError) return error.message;
  if (error instanceof LlmRefusalError) {
    return `The model declined this request${
      error.category !== null ? ` (${error.category})` : ""
    }. Nothing was extracted.`;
  }
  if (error instanceof LlmTruncatedError) {
    return "The extraction hit the token limit and is incomplete. Try a shorter resume, or " +
      "paste it in two passes.";
  }
  if (error instanceof Error && error.name === "LlmError") return error.message;
  return null;
}

const PasteForm: FC<{ csrfToken: string; error?: string }> = (props) => (
  <Layout title="Seed from a resume" current="dossier" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>Seed from a resume</h1>
        <p class="lede">
          Paste a resume and the model will propose facts for your fact set — one per summary line,
          role, bullet, skill, education entry, and project. Nothing is created until you review the
          list on the next page and submit it yourself; extraction only ever produces candidates.
        </p>
      </div>
      <a class="button quiet" href="/dossier">← Dossier</a>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}

    <section class="panel">
      <form method="post" action="/dossier/seed" class="stack">
        <CsrfField token={props.csrfToken} />
        <Field
          wide
          label="Resume text"
          for="resume-text"
          hint="Paste the whole thing — plain text or markdown both work."
        >
          <textarea id="resume-text" name="resume_text" rows={18} required></textarea>
        </Field>
        <div class="row">
          <button type="submit" class="primary">Extract facts</button>
        </div>
      </form>
    </section>
  </Layout>
);

const CandidateRow: FC<{ fact: SeedFact; parentLabel: string | undefined }> = ({
  fact,
  parentLabel,
}) => {
  const key = String(fact.index);
  return (
    <div class="fact-row">
      <div class="fact-main">
        <div class="field-row">
          <CheckboxField
            label="Include"
            name={`fact_${key}_include`}
            id={`include-${key}`}
            checked
          />
          <Field label="Kind" for={`kind-${key}`}>
            <select id={`kind-${key}`} name={`fact_${key}_kind`}>
              {FACT_KINDS.map((kind) => (
                <option value={kind} selected={fact.kind === kind}>{KIND_LABELS[kind]}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field wide label="Text" for={`text-${key}`}>
          <textarea id={`text-${key}`} name={`fact_${key}_text`} rows={2}>{fact.text}</textarea>
        </Field>
        <div class="field-row">
          <Field label="Organization" for={`org-${key}`}>
            <input
              id={`org-${key}`}
              type="text"
              name={`fact_${key}_organization`}
              value={fact.organization ?? ""}
            />
          </Field>
          <Field label="Tags" for={`tags-${key}`} hint="Comma separated.">
            <input
              id={`tags-${key}`}
              type="text"
              name={`fact_${key}_tags`}
              value={fact.tags.join(", ")}
            />
          </Field>
        </div>
        <div class="field-row">
          <Field label="Start" for={`start-${key}`}>
            <input
              id={`start-${key}`}
              type="month"
              name={`fact_${key}_start_date`}
              value={monthValue(fact.startDate)}
            />
          </Field>
          <Field label="End" for={`end-${key}`} hint="Blank means present.">
            <input
              id={`end-${key}`}
              type="month"
              name={`fact_${key}_end_date`}
              value={monthValue(fact.endDate)}
            />
          </Field>
        </div>
        {parentLabel !== undefined && <p class="field-hint">Under: {parentLabel}</p>}
        <input type="hidden" name={`fact_${key}_parent_of`} value={fact.parentOf ?? ""} />
      </div>
    </div>
  );
};

const ReviewPage: FC<{
  facts: readonly SeedFact[];
  identity: SeedIdentity | null;
  hasExistingIdentity: boolean;
  csrfToken: string;
}> = (props) => {
  const labelFor = (index: number | undefined) => {
    if (index === undefined) return undefined;
    const parent = props.facts.find((f) => f.index === index);
    return parent === undefined ? undefined : parent.text.slice(0, 60);
  };

  return (
    <Layout title="Review extracted facts" current="dossier" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Review before adding</h1>
          <p class="lede">
            {props.facts.length} candidate{props.facts.length === 1 ? "" : "s"}{" "}
            extracted from what you pasted. Everything is editable and unchecking a box leaves it
            out entirely — nothing below is in your fact set yet.
          </p>
        </div>
        <a class="button quiet" href="/dossier/seed">← Start over</a>
      </div>

      <form method="post" action="/dossier/seed/create" class="stack">
        <CsrfField token={props.csrfToken} />
        <input
          type="hidden"
          name="fact_indexes"
          value={props.facts.map((f) => f.index).join(",")}
        />

        {props.identity !== null && (
          <section class="panel">
            <header>
              <h2>Identity</h2>
            </header>
            <CheckboxField
              label={props.hasExistingIdentity
                ? "Overwrite your saved identity with this"
                : "Save this as your identity"}
              name="identity_include"
              id="identity-include"
              checked={!props.hasExistingIdentity}
              {...(props.hasExistingIdentity
                ? { hint: "You already have identity info saved on the Dossier page." }
                : {})}
            />
            <div class="field-row">
              <Field label="Name" for="identity-name">
                <input
                  id="identity-name"
                  type="text"
                  name="identity_name"
                  value={props.identity.name ?? ""}
                />
              </Field>
              <Field label="Email" for="identity-email">
                <input
                  id="identity-email"
                  type="text"
                  name="identity_email"
                  value={props.identity.email ?? ""}
                />
              </Field>
            </div>
            <div class="field-row">
              <Field label="Phone" for="identity-phone">
                <input
                  id="identity-phone"
                  type="text"
                  name="identity_phone"
                  value={props.identity.phone ?? ""}
                />
              </Field>
              <Field label="Location" for="identity-location">
                <input
                  id="identity-location"
                  type="text"
                  name="identity_location"
                  value={props.identity.location ?? ""}
                />
              </Field>
            </div>
            <Field wide label="Links" for="identity-links" hint="One per line.">
              <textarea id="identity-links" name="identity_links" rows={2}>
                {props.identity.links.join("\n")}
              </textarea>
            </Field>
          </section>
        )}

        <section class="panel">
          <header>
            <h2>Facts</h2>
          </header>
          {props.facts.length === 0
            ? <p class="empty">Nothing came back. Try pasting more of the resume.</p>
            : props.facts.map((fact) => (
              <CandidateRow
                key={fact.index}
                fact={fact}
                parentLabel={labelFor(fact.parentOf)}
              />
            ))}
        </section>

        <div class="row">
          <button type="submit" class="primary">Add checked facts</button>
        </div>
      </form>
    </Layout>
  );
};

export const seedRoutes = new Hono<AppEnv>();

seedRoutes.get("/dossier/seed", (c) => {
  const error = c.req.query("error");
  return c.html(
    <PasteForm
      csrfToken={c.get("csrfToken")}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

seedRoutes.post("/dossier/seed", async (c) => {
  const services = c.get("services");
  const body = await c.req.parseBody();
  const resumeText = typeof body.resume_text === "string" ? body.resume_text.trim() : "";

  const back = (message: string) =>
    c.redirect(`/dossier/seed?error=${encodeURIComponent(message)}`, 303);

  if (resumeText === "") return back("Paste a resume first.");
  if (services.llm === null) return back("No Anthropic API key is configured (ANTHROPIC_API_KEY).");

  try {
    const response = await services.llm.complete(buildSeedRequest(resumeText));
    const result = parseSeedResponse(response.json);
    if (result.facts.length === 0) {
      return back("The model found nothing to extract. Check the pasted text and try again.");
    }
    const identity = await services.settings.get<Identity>(IDENTITY_SETTING);
    c.get("logger").info("resume seed extracted", {
      facts: result.facts.length,
      model: response.model,
      cacheRead: response.usage.cacheReadInputTokens,
    });
    return c.html(
      <ReviewPage
        facts={result.facts}
        identity={result.identity}
        hasExistingIdentity={identity !== null}
        csrfToken={c.get("csrfToken")}
      />,
    );
  } catch (error) {
    const message = explain(error);
    if (message !== null) {
      c.get("logger").warn("resume seed rejected", { reason: message });
      return back(message);
    }
    throw error;
  }
});

/** "2023-04" (a month input) → UTC first-of-month, or undefined. */
function parseMonth(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
}

seedRoutes.post("/dossier/seed/create", async (c) => {
  const services = c.get("services");
  const body = await c.req.parseBody();

  const indexes = typeof body.fact_indexes === "string"
    ? body.fact_indexes.split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n))
    : [];

  interface Row {
    readonly index: number;
    readonly kind: FactKind;
    readonly text: string;
    readonly organization?: string;
    readonly tags: string[];
    readonly startDate?: Date;
    readonly endDate?: Date;
    readonly parentOf?: number;
  }

  const rows: Row[] = [];
  for (const index of indexes) {
    if (body[`fact_${index}_include`] === undefined) continue; // unchecked
    const kindRaw = body[`fact_${index}_kind`];
    const kind = typeof kindRaw === "string" && isFactKind(kindRaw) ? kindRaw : null;
    const text = typeof body[`fact_${index}_text`] === "string"
      ? (body[`fact_${index}_text`] as string).trim()
      : "";
    if (kind === null || text === "") continue; // an edited-away row is a skip, not an error

    const organization = typeof body[`fact_${index}_organization`] === "string"
      ? (body[`fact_${index}_organization`] as string).trim()
      : "";
    const startDate = parseMonth(body[`fact_${index}_start_date`]);
    const endDate = parseMonth(body[`fact_${index}_end_date`]);
    const parentOfRaw = body[`fact_${index}_parent_of`];
    const parentOf = typeof parentOfRaw === "string" && parentOfRaw !== ""
      ? Number(parentOfRaw)
      : undefined;

    rows.push({
      index,
      kind,
      text,
      tags: parseTags(body[`fact_${index}_tags`]),
      ...(organization !== "" ? { organization } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(parentOf !== undefined ? { parentOf } : {}),
    });
  }

  // Parents first, so bullets have a real FactId to point at (§8: a bullet
  // needs a parent role or project — the same rule the manual form enforces).
  const createdIdByIndex = new Map<number, FactId>();
  let skippedBullets = 0;
  const parents = rows.filter((r) => r.kind !== "bullet");
  const bullets = rows.filter((r) => r.kind === "bullet");

  for (const row of parents) {
    const created = await services.facts.create({
      kind: row.kind,
      text: row.text,
      tags: row.tags,
      ...(row.organization !== undefined ? { organization: row.organization } : {}),
      ...(row.startDate !== undefined ? { startDate: row.startDate } : {}),
      ...(row.endDate !== undefined ? { endDate: row.endDate } : {}),
    });
    createdIdByIndex.set(row.index, created.id);
  }
  for (const row of bullets) {
    // Either parentOf wasn't set, or its role/project was unchecked, so
    // there's nothing for this bullet to attach to — the same rule the
    // manual "Add a fact" form enforces.
    const parentId = row.parentOf !== undefined ? createdIdByIndex.get(row.parentOf) : undefined;
    if (parentId === undefined) {
      skippedBullets++;
      continue;
    }
    const created = await services.facts.create({
      kind: "bullet",
      text: row.text,
      tags: row.tags,
      parentId,
      ...(row.organization !== undefined ? { organization: row.organization } : {}),
      ...(row.startDate !== undefined ? { startDate: row.startDate } : {}),
      ...(row.endDate !== undefined ? { endDate: row.endDate } : {}),
    });
    createdIdByIndex.set(row.index, created.id);
  }

  if (body.identity_include !== undefined) {
    const field = (key: string) => {
      const value = body[key];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    const name = field("identity_name");
    if (name !== undefined) {
      const links = typeof body.identity_links === "string"
        ? body.identity_links.split("\n").map((l) => l.trim()).filter((l) => l !== "")
        : [];
      const email = field("identity_email");
      const phone = field("identity_phone");
      const location = field("identity_location");
      const identity: Identity = {
        name,
        links,
        ...(email !== undefined ? { email } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(location !== undefined ? { location } : {}),
      };
      await services.settings.set(IDENTITY_SETTING, identity);
    }
  }

  c.get("logger").info("resume seed applied", {
    created: createdIdByIndex.size,
    skippedBullets,
  });

  const notice = skippedBullets > 0
    ? `Created ${createdIdByIndex.size} fact(s). Skipped ${skippedBullets} bullet(s) whose ` +
      `parent role or project wasn't included — add them by hand once the parent exists.`
    : `Created ${createdIdByIndex.size} fact(s) from your resume.`;
  return c.redirect(`/dossier?notice=${encodeURIComponent(notice)}`, 303);
});
