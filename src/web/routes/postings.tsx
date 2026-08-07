/** @jsxImportSource hono/jsx */

/**
 * Posting browsing (M1).
 *
 * Search here is Postgres full-text — a lexical match, and labelled as such.
 * Semantic matching against the skill profile is M3 and lives elsewhere; it
 * would be misleading to let this page imply it is already doing that job.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import {
  Asserted,
  CheckboxField,
  Derived,
  Field,
  FieldActions,
  FieldLegend,
  formatDate,
  formatDateTime,
  ProvenanceLine,
  relativeAge,
  RemoteHintChip,
  Tabs,
} from "@web/components.tsx";
import { Markdown } from "@web/markdown.tsx";
import type { AppEnv } from "@web/types.ts";
import { asBoardId, asPostingId, type BoardId } from "@platform/ids.ts";
import type { Board, Compensation, Posting } from "@domain/discovery/types.ts";

const PAGE_SIZE = 25;

/**
 * The source's own wording wins when it exists; the structured fields are the
 * fallback rendering, not a reinterpretation.
 */
function formatCompensation(comp: Compensation): string {
  if (comp.raw !== undefined && comp.raw.trim() !== "") return comp.raw;
  const amounts = [comp.minAmount, comp.maxAmount]
    .filter((v): v is number => v !== undefined)
    .map((v) => v.toLocaleString("en-US"));
  if (amounts.length === 0) return "published, but in no structure this app recognizes";
  const range = [...new Set(amounts)].join("–");
  const withCurrency = comp.currency !== undefined ? `${comp.currency} ${range}` : range;
  return comp.interval !== undefined ? `${withCurrency} / ${comp.interval}` : withCurrency;
}

interface ListProps {
  readonly postings: readonly Posting[];
  readonly total: number;
  readonly boards: readonly Board[];
  readonly csrfToken: string;
  readonly now: Date;
  readonly search: string;
  readonly boardId: string;
  readonly includeUnlisted: boolean;
  readonly offset: number;
}

function pageHref(props: ListProps, offset: number): string {
  const params = new URLSearchParams();
  if (props.search !== "") params.set("q", props.search);
  if (props.boardId !== "") params.set("board", props.boardId);
  if (props.includeUnlisted) params.set("unlisted", "1");
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query === "" ? "/postings" : `/postings?${query}`;
}

const PostingsPage: FC<ListProps> = (props) => {
  const companyById = new Map(props.boards.map((b) => [b.id as string, b.companyName]));
  return (
    <Layout title="Postings" current="matches" csrfToken={props.csrfToken}>
      <Tabs
        label="Matches sections"
        items={[
          { href: "/matches", label: "Matches" },
          { href: "/postings", label: "All postings", current: true },
          { href: "/tuning", label: "Tuning" },
        ]}
      />
      <div class="page-head">
        <div>
          <h1>Postings</h1>
          <p class="lede">
            Everything collected from the registered boards. Search is a keyword match over titles
            and descriptions — semantic matching against your skill profile arrives in a later
            milestone.
          </p>
        </div>
      </div>

      <section class="panel">
        <form method="get" action="/postings" class="stack">
          <div class="field-row">
            <Field label="Search" for="q" hint="Keyword match over titles and descriptions.">
              <input
                id="q"
                name="q"
                type="search"
                value={props.search}
                placeholder="postgres, typescript"
              />
            </Field>
            <Field label="Board" for="board">
              <select id="board" name="board">
                <option value="">All boards</option>
                {props.boards.map((board) => (
                  <option value={board.id} selected={props.boardId === board.id}>
                    {board.companyName}
                  </option>
                ))}
              </select>
            </Field>
            <CheckboxField
              id="unlisted"
              name="unlisted"
              value="1"
              checked={props.includeUnlisted}
              label="Include postings no longer listed"
              hint="No longer listed means only that: not filled, not cancelled, not closed."
            />
            <FieldActions>
              <button type="submit" class="primary">Apply</button>
            </FieldActions>
          </div>
        </form>
      </section>

      <section class="panel">
        <header>
          <h2>
            {props.total} posting{props.total === 1 ? "" : "s"}
          </h2>
          <FieldLegend />
        </header>

        {props.postings.length === 0
          ? (
            <p class="empty">
              Nothing matches. If you expected results, check the coverage panel for what the last
              run actually saw.
            </p>
          )
          : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Company</th>
                    <th>Location</th>
                    <th>Posted</th>
                    <th>As of</th>
                  </tr>
                </thead>
                <tbody>
                  {props.postings.map((posting) => (
                    <tr>
                      <td>
                        <a
                          class="posting-title"
                          href={`/postings/${encodeURIComponent(posting.id)}`}
                        >
                          {posting.title}
                        </a>
                        <div class="meta-line">
                          {posting.department !== undefined && (
                            <Asserted>{posting.department}</Asserted>
                          )}
                          {!posting.currentlyListed && (
                            <span class="chip warn">no longer listed</span>
                          )}
                        </div>
                      </td>
                      <td>{companyById.get(posting.boardId) ?? posting.boardId}</td>
                      <td>
                        <div>
                          <Asserted>{posting.locationRaw || "—"}</Asserted>
                        </div>
                        {posting.derived !== null && (
                          <div class="meta-line">
                            <RemoteHintChip hint={posting.derived.remoteHint} />
                          </div>
                        )}
                      </td>
                      <td>{formatDate(posting.postedAt)}</td>
                      <td title={formatDateTime(posting.provenance.fetchedAt)}>
                        {relativeAge(posting.provenance.fetchedAt, props.now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <div class="pagination gap-above">
          <span>
            Showing {props.offset + 1}–{Math.min(props.offset + PAGE_SIZE, props.total)} of{" "}
            {props.total}
          </span>
          <span class="row">
            {props.offset > 0 && (
              <a class="button" href={pageHref(props, Math.max(0, props.offset - PAGE_SIZE))}>
                Previous
              </a>
            )}
            {props.offset + PAGE_SIZE < props.total && (
              <a class="button" href={pageHref(props, props.offset + PAGE_SIZE)}>Next</a>
            )}
          </span>
        </div>
      </section>
    </Layout>
  );
};

const PostingDetailPage: FC<{ posting: Posting; company: string; csrfToken: string; now: Date }> = (
  props,
) => {
  const p = props.posting;
  return (
    <Layout title={p.title} current="matches" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>{p.title}</h1>
          <p class="lede">
            {props.company}
            {p.department !== undefined ? ` · ${p.department}` : ""}
          </p>
        </div>
        <div class="row">
          <a
            class="button primary"
            href={p.applyUrl}
            rel="noreferrer noopener nofollow"
            target="_blank"
          >
            Open the posting
          </a>
        </div>
      </div>

      {!p.currentlyListed && (
        <p class="notice warn">
          This posting is no longer listed on the board. It was last seen{" "}
          {formatDateTime(p.lastSeenAt)}. That is all the data supports — it does not mean the role
          was filled, cancelled or closed.
        </p>
      )}

      <section class="panel">
        <header>
          <h2>Details</h2>
          <FieldLegend />
        </header>
        <div class="grid">
          <div class="stack">
            <div>
              <label>Location, as published</label>
              <Asserted>{p.locationRaw || "not stated"}</Asserted>
            </div>
            {p.derived?.locationNormalized !== null && p.derived !== null && (
              <div>
                <label>Location, normalized</label>
                <Derived title="Separators unified and modality prefixes stripped by Job Radar">
                  {p.derived.locationNormalized}
                </Derived>
              </div>
            )}
            <div>
              <label>Work arrangement</label>
              {p.workplaceRaw !== undefined
                ? <Asserted>{p.workplaceRaw}</Asserted>
                : p.derived !== null
                ? <RemoteHintChip hint={p.derived.remoteHint} />
                : <span class="chip muted">not derived</span>}
              <p class="field-hint">
                {p.workplaceRaw !== undefined
                  ? "As published by the feed."
                  : "Inferred from the location string. This feed publishes no work-arrangement field."}
              </p>
            </div>
          </div>
          <div class="stack">
            <div>
              <label>Compensation</label>
              {p.compensation === undefined
                ? <span class="chip muted">not published by this source</span>
                : <Asserted>{formatCompensation(p.compensation)}</Asserted>}
            </div>
            <div>
              <label>Published</label>
              <Asserted>{formatDate(p.postedAt)}</Asserted>
            </div>
            <div>
              <label>First seen by Job Radar</label>
              <Derived title="When this application first observed the posting">
                {formatDateTime(p.firstSeenAt)}
              </Derived>
            </div>
          </div>
        </div>
        <div class="gap-above">
          <ProvenanceLine provenance={p.provenance} />
        </div>
      </section>

      <section class="panel">
        <header>
          <h2>Description</h2>
          <span class="chip muted">as published, converted to markdown</span>
        </header>
        {
          /*
          Rendered, not printed. The stored text is still the exact markdown the
          converter produced — this only decides how it is shown, and the
          "as published" chip above still describes where it came from.
        */
        }
        <div class="posting-body">
          <Markdown text={p.descriptionText} />
        </div>
      </section>
    </Layout>
  );
};

export const postingRoutes = new Hono<AppEnv>();

postingRoutes.get("/postings", async (c) => {
  const services = c.get("services");
  const search = (c.req.query("q") ?? "").trim();
  const rawBoard = (c.req.query("board") ?? "").trim();
  const includeUnlisted = c.req.query("unlisted") === "1";
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);

  let boardId: BoardId | undefined;
  if (rawBoard !== "") {
    try {
      boardId = asBoardId(rawBoard);
    } catch {
      boardId = undefined;
    }
  }

  const [{ postings, total }, boards] = await Promise.all([
    services.postings.list({
      ...(boardId !== undefined ? { boardId } : {}),
      includeUnlisted,
      search,
      limit: PAGE_SIZE,
      offset,
    }),
    services.boards.list(),
  ]);

  return c.html(
    <PostingsPage
      postings={postings}
      total={total}
      boards={boards}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      search={search}
      boardId={boardId ?? ""}
      includeUnlisted={includeUnlisted}
      offset={offset}
    />,
  );
});

postingRoutes.get("/postings/:id", async (c) => {
  const services = c.get("services");
  let posting: Posting | null;
  try {
    posting = await services.postings.get(asPostingId(c.req.param("id")));
  } catch {
    return c.notFound();
  }
  if (posting === null) return c.notFound();

  const board = await services.boards.get(posting.boardId);
  return c.html(
    <PostingDetailPage
      posting={posting}
      company={board?.companyName ?? posting.boardId}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
    />,
  );
});
