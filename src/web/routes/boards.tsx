/** @jsxImportSource hono/jsx */

/**
 * Board management (M1). The registry is database-backed and edited here (§4).
 *
 * Plain forms and full page loads throughout — board management is exactly the
 * case §9 says should be a form and a redirect.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import {
  Asserted,
  CsrfField,
  Field,
  FieldActions,
  formatDateTime,
  Notice,
  relativeAge,
  StatusChip,
  Tabs,
} from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { asBoardId, type BoardId, IdError, isPlatform, PLATFORMS } from "@platform/ids.ts";
import type { Board, Snapshot } from "@domain/discovery/types.ts";
import { collect } from "@domain/discovery/collect.ts";
import {
  type BoardCandidate,
  resolveBoards,
  type ResolveReport,
} from "@domain/discovery/resolve.ts";

/** Platforms with an adapter today. The rest are listed but not selectable. */
const IMPLEMENTED: ReadonlySet<string> = new Set(["greenhouse", "lever", "ashby"]);

/** A malformed id in the path is a 404, not an exception (IdError) escaping as a 500. */
function parseBoardId(raw: string): BoardId | null {
  try {
    return asBoardId(raw);
  } catch {
    return null;
  }
}

interface BoardsPageProps {
  readonly boards: readonly Board[];
  readonly counts: Map<BoardId, { listed: number; total: number }>;
  readonly csrfToken: string;
  readonly now: Date;
  readonly error?: string;
  readonly notice?: string;
}

const BoardsPage: FC<BoardsPageProps> = (props) => (
  <Layout title="Boards" current="boards" csrfToken={props.csrfToken}>
    <Tabs
      label="Boards sections"
      items={[
        { href: "/boards", label: "Boards", current: true },
        { href: "/coverage", label: "Coverage" },
      ]}
    />
    <div class="page-head">
      <div>
        <h1>Boards</h1>
        <p class="lede">
          The board registry is the denominator for every count in this application. Anything not
          listed here is not seen at all.
        </p>
      </div>
    </div>

    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
    {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

    <section class="panel">
      <header>
        <h2>Add or update a board</h2>
        <a class="button primary" href="/boards/find">Find a board by company name</a>
      </header>
      <p class="panel-note">
        Platform and slug together identify a board. Saving an existing pair updates its details and
        leaves its fetch history alone. If you do not already know the slug, look it up rather than
        guessing — a wrong guess is indistinguishable from a company that is not on this platform.
      </p>
      <form method="post" action="/boards" class="stack gap-above">
        <CsrfField token={props.csrfToken} />
        <div class="field-row">
          <Field label="Platform" for="platform" hint="Three have adapters today.">
            <select id="platform" name="platform" required>
              {PLATFORMS.map((platform) => (
                <option value={platform} disabled={!IMPLEMENTED.has(platform)}>
                  {platform}
                  {IMPLEMENTED.has(platform) ? "" : " — adapter not built yet"}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Board slug"
            for="slug"
            hint="The identifier in the board's public feed URL."
          >
            <input id="slug" name="slug" type="text" required placeholder="vercel" />
          </Field>
          <Field
            label="Company name"
            for="companyName"
            hint="Yours to author. Feeds disagree with themselves about this."
          >
            <input id="companyName" name="companyName" type="text" required placeholder="Vercel" />
          </Field>
        </div>
        <div class="field-row">
          <Field label="Tags" for="tags" hint="Comma separated.">
            <input id="tags" name="tags" type="text" placeholder="infra, remote-friendly" />
          </Field>
          <Field label="Notes" for="notes" hint="Why this board is worth watching.">
            <input id="notes" name="notes" type="text" />
          </Field>
        </div>
        <div class="row">
          <button type="submit" class="primary">Save board</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <header>
        <h2>
          Registered boards <span class="chip">{props.boards.length}</span>
        </h2>
        <form method="post" action="/collect" class="inline-form">
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="primary">Fetch all active boards</button>
        </form>
      </header>

      {props.boards.length === 0
        ? <p class="empty">No boards yet. Add one above to start collecting.</p>
        : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Board</th>
                  <th class="numeric">Listed</th>
                  <th class="numeric">Total seen</th>
                  <th>Last fetch</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {props.boards.map((board) => {
                  const count = props.counts.get(board.id) ?? { listed: 0, total: 0 };
                  const encoded = encodeURIComponent(board.id);
                  return (
                    <tr>
                      <td>
                        <a class="posting-title" href={`/boards/${encoded}`}>{board.companyName}</a>
                        {!board.active && <span class="chip muted chip-inline">inactive</span>}
                        {board.tags.length > 0 && (
                          <ul class="tag-list gap-above-tight">
                            {board.tags.map((tag) => <li class="chip" key={tag}>{tag}</li>)}
                          </ul>
                        )}
                      </td>
                      <td>
                        <code>{board.platform}</code> / <code>{board.slug}</code>
                      </td>
                      <td class="numeric">{count.listed}</td>
                      <td class="numeric">{count.total}</td>
                      <td title={formatDateTime(board.lastFetchAt)}>
                        {relativeAge(board.lastFetchAt, props.now)}
                      </td>
                      <td>
                        <StatusChip
                          status={board.lastFetchStatus}
                          failures={board.consecutiveFailures}
                        />
                        {board.lastFetchError !== undefined && (
                          <div class="field-hint constrain">{board.lastFetchError}</div>
                        )}
                      </td>
                      <td>
                        <div class="row table-actions">
                          <form
                            method="post"
                            action={`/boards/${encoded}/fetch`}
                            class="inline-form"
                          >
                            <CsrfField token={props.csrfToken} />
                            <button type="submit">Fetch now</button>
                          </form>
                          <form
                            method="post"
                            action={`/boards/${encoded}/${
                              board.active ? "deactivate" : "activate"
                            }`}
                            class="inline-form"
                          >
                            <CsrfField token={props.csrfToken} />
                            <button type="submit" class="quiet">
                              {board.active ? "Deactivate" : "Activate"}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  </Layout>
);

/**
 * One answer from one platform. A hit that the adapter actually read carries a
 * posting count and a few titles, which is what distinguishes the Esri you mean
 * from a company that merely shares the name.
 */
const CandidateRow: FC<{
  candidate: BoardCandidate;
  registered: boolean;
  csrfToken: string;
  now: Date;
}> = ({ candidate, registered, csrfToken, now }) => (
  <div class="candidate">
    <div class="candidate-main">
      <p class="candidate-id">
        <code>{candidate.platform}</code> / <code>{candidate.slug}</code>
        {candidate.companyName !== undefined && (
          <Asserted>
            <span class="chip-inline">{candidate.companyName}</span>
          </Asserted>
        )}
        {registered && <span class="chip accent chip-inline">already registered</span>}
      </p>

      {candidate.found && candidate.postingCount !== undefined && (
        <p class="meta-line candidate-samples">
          <span>
            <Asserted>{candidate.postingCount}</Asserted>{" "}
            posting{candidate.postingCount === 1 ? "" : "s"}
          </span>
          {/* Two postings can share a title, so the index is part of the key. */}
          {(candidate.sampleTitles ?? []).map((title, index) => (
            <span key={`${index}-${title}`}>{title}</span>
          ))}
        </p>
      )}

      {candidate.error !== undefined && <p class="field-hint warn-text">{candidate.error}</p>}

      <p class="field-hint" title={formatDateTime(candidate.checkedAt)}>
        checked {relativeAge(candidate.checkedAt, now)}
      </p>
    </div>

    {candidate.found && !registered && (
      <form method="post" action="/boards" class="inline-form">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="platform" value={candidate.platform} />
        <input type="hidden" name="slug" value={candidate.slug} />
        <input
          type="hidden"
          name="companyName"
          value={candidate.companyName ?? candidate.slug}
        />
        <button type="submit" class="primary">Add this board</button>
      </form>
    )}
  </div>
);

const FindPage: FC<{
  query: string;
  report: ResolveReport | null;
  registered: ReadonlySet<string>;
  catalogue: readonly BoardCandidate[];
  csrfToken: string;
  now: Date;
  error?: string;
}> = (props) => {
  const hits = props.report?.results.filter((r) => r.found) ?? [];
  const misses = props.report?.results.filter((r) => !r.found) ?? [];
  return (
    <Layout title="Find a board" current="boards" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Find a board</h1>
          <p class="lede">
            Name a company and this asks each platform whether it has a board by that name. No ATS
            publishes a list of its customers, so there is nothing to search — but all three answer
            the question directly, and guessing well is cheap.
          </p>
        </div>
        <a class="button" href="/boards">All boards</a>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}

      <section class="panel">
        <form method="get" action="/boards/find" class="stack">
          <div class="field-row">
            <Field
              label="Company name or board URL"
              for="q"
              hint="A careers-page URL skips the guessing entirely."
            >
              <input
                id="q"
                name="q"
                type="search"
                value={props.query}
                required
                placeholder="Esri — or https://boards.greenhouse.io/esri"
              />
            </Field>
            <FieldActions>
              <button type="submit" class="primary">Look it up</button>
            </FieldActions>
          </div>
        </form>
      </section>

      {props.report !== null && (
        <section class="panel stack">
          <header>
            <h2>
              {hits.length} board{hits.length === 1 ? "" : "s"} for "{props.report.query}"
            </h2>
            <div class="row">
              {props.report.fromCache && <span class="chip muted">from the catalogue</span>}
              <a
                class="button"
                href={`/boards/find?q=${encodeURIComponent(props.report.query)}&refresh=1`}
              >
                Check again
              </a>
            </div>
          </header>

          <p class="panel-note">
            {props.report.interpretedAs === "url"
              ? "Read straight from the URL — one pair to check, no guessing."
              : `Tried ${
                props.report.tried.map((c) => c.slug).join(", ")
              } against every platform with an adapter.`}
          </p>

          {hits.length === 0
            ? (
              <p class="empty">
                No board answered. The company may be on an ATS this app cannot read yet, may use a
                slug that is not derivable from its name, or may host its own careers page. Pasting
                the careers-page URL is the reliable way in.
              </p>
            )
            : hits.map((candidate) => (
              <CandidateRow
                key={`${candidate.platform}:${candidate.slug}`}
                candidate={candidate}
                registered={props.registered.has(`${candidate.platform}:${candidate.slug}`)}
                csrfToken={props.csrfToken}
                now={props.now}
              />
            ))}

          {misses.length > 0 && (
            <details>
              <summary>
                What was asked and answered no ({misses.length})
              </summary>
              <ul class="tag-list gap-above">
                {misses.map((candidate) => (
                  <li
                    class={`chip ${candidate.error !== undefined ? "warn" : "muted"}`}
                    key={`${candidate.platform}:${candidate.slug}`}
                    {...(candidate.error !== undefined ? { title: candidate.error } : {})}
                  >
                    {candidate.platform}/{candidate.slug}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {props.catalogue.length > 0 && (
        <section class="panel">
          <header>
            <h2>Boards this app has found before</h2>
          </header>
          <p class="panel-note">
            Every lookup is recorded, so asking twice costs nothing. This is the catalogue as it has
            accumulated — the companies you actually looked for.
          </p>
          <ul class="tag-list gap-above">
            {props.catalogue.map((candidate) => (
              <li key={`${candidate.platform}:${candidate.slug}`}>
                <a
                  class={`chip ${
                    props.registered.has(`${candidate.platform}:${candidate.slug}`)
                      ? "accent"
                      : "ok"
                  }`}
                  href={`/boards/find?q=${encodeURIComponent(candidate.slug)}`}
                >
                  {candidate.companyName ?? candidate.slug}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Layout>
  );
};

const BoardDetailPage: FC<{
  board: Board;
  snapshots: readonly Snapshot[];
  counts: { listed: number; total: number };
  csrfToken: string;
  now: Date;
}> = (props) => (
  <Layout title={props.board.companyName} current="boards" csrfToken={props.csrfToken}>
    <div class="page-head">
      <div>
        <h1>{props.board.companyName}</h1>
        <p class="lede">
          <code>{props.board.platform}</code> / <code>{props.board.slug}</code> · added{" "}
          {formatDateTime(props.board.addedAt)}
        </p>
      </div>
      <div class="row">
        <form method="post" action={`/boards/${encodeURIComponent(props.board.id)}/fetch`}>
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="primary">Fetch now</button>
        </form>
        <a class="button" href={`/postings?board=${encodeURIComponent(props.board.id)}`}>
          View postings
        </a>
      </div>
    </div>

    {props.board.consecutiveFailures >= 3 && (
      <Notice kind="warn">
        {props.board.consecutiveFailures}{" "}
        consecutive failures. This almost always means the slug changed or the company moved to a
        different ATS.
      </Notice>
    )}

    <section class="panel">
      <header>
        <h2>Fetch history</h2>
      </header>
      <p class="panel-note">
        Each row is one full snapshot — the complete set of posting ids and content hashes at that
        moment. Diffs are computed by comparing two of these, never by trusting the source's own
        change timestamps.
      </p>
      {props.snapshots.length === 0
        ? <p class="empty">This board has never been fetched.</p>
        : (
          <div class="table-scroll gap-above">
            <table>
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>Status</th>
                  <th class="numeric">Postings</th>
                  <th>Adapter</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {props.snapshots.map((snapshot) => (
                  <tr>
                    <td title={formatDateTime(snapshot.takenAt)}>
                      {relativeAge(snapshot.takenAt, props.now)}
                    </td>
                    <td>
                      {snapshot.status === "ok"
                        ? <span class="chip ok">ok</span>
                        : <span class="chip danger">failed</span>}
                    </td>
                    <td class="numeric">{snapshot.postingCount}</td>
                    <td>
                      <code>{snapshot.adapterVersion}</code>
                    </td>
                    <td class="field-hint">{snapshot.errorReason ?? snapshot.sourceUrl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>

    <section class="panel">
      <header>
        <h2>Danger zone</h2>
      </header>
      <p class="panel-note">
        Removing a board deletes its postings and its snapshot history. Deactivating it instead
        keeps everything and simply stops fetching.
      </p>
      <form
        method="post"
        action={`/boards/${encodeURIComponent(props.board.id)}/delete`}
        class="gap-above"
      >
        <CsrfField token={props.csrfToken} />
        <button type="submit" class="danger">
          Delete {props.board.companyName} and its {props.counts.total} postings
        </button>
      </form>
    </section>
  </Layout>
);

export const boardRoutes = new Hono<AppEnv>();

boardRoutes.get("/boards", async (c) => {
  const services = c.get("services");
  const [boards, counts] = await Promise.all([
    services.boards.list(),
    services.postings.countByBoard(),
  ]);
  const error = c.req.query("error");
  const notice = c.req.query("notice");
  return c.html(
    <BoardsPage
      boards={boards}
      counts={counts}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(error !== undefined ? { error } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

boardRoutes.post("/boards", async (c) => {
  const services = c.get("services");
  const body = await c.req.parseBody();

  const platform = typeof body.platform === "string" ? body.platform : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  const tags = typeof body.tags === "string"
    ? body.tags.split(",").map((t) => t.trim()).filter((t) => t !== "")
    : [];

  const fail = (message: string) => c.redirect(`/boards?error=${encodeURIComponent(message)}`, 303);

  if (!isPlatform(platform)) return fail(`Unknown platform: ${platform}`);
  if (companyName === "") return fail("Company name is required.");

  try {
    await services.boards.upsert({
      platform,
      slug,
      companyName,
      tags,
      ...(notes !== "" ? { notes } : {}),
    });
  } catch (error) {
    if (error instanceof IdError) return fail(error.message);
    throw error;
  }

  return c.redirect(`/boards?notice=${encodeURIComponent(`Saved ${companyName}.`)}`, 303);
});

/** How much of the accumulated catalogue the find page shows. */
const CATALOGUE_LIMIT = 24;

/*
 * Registered before `/boards/:id` so the literal path is not read as a board id.
 *
 * A GET rather than a POST, even though it reaches the network: the lookup
 * changes nothing the user owns, the result is worth bookmarking and sharing
 * with yourself, and "check again" is then just a different URL. The catalogue
 * keeps a repeated load from becoming a repeated request.
 */
boardRoutes.get("/boards/find", async (c) => {
  const services = c.get("services");
  const query = (c.req.query("q") ?? "").trim();
  const refresh = c.req.query("refresh") === "1";

  const [boards, catalogue] = await Promise.all([
    services.boards.list(),
    services.boardCandidates.recent(CATALOGUE_LIMIT),
  ]);
  const registered = new Set(boards.map((board) => `${board.platform}:${board.slug}`));

  let report: ResolveReport | null = null;
  let error: string | undefined;

  if (query !== "") {
    try {
      report = await resolveBoards(query, {
        candidates: services.boardCandidates,
        probe: services.probeBoard,
        sourceFor: services.sourceFor,
        clock: services.clock,
        logger: services.logger,
      }, { refresh });
      if (report.tried.length === 0) {
        error = `There are no letters or digits in "${query}" to build a slug from.`;
        report = null;
      }
    } catch (thrown) {
      // A lookup that breaks is reported, not swallowed into "no results" —
      // those mean different things and the user has to be able to tell.
      services.logger.warn("board lookup failed", {
        query,
        error: thrown instanceof Error ? thrown.message : String(thrown),
      });
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
  }

  return c.html(
    <FindPage
      query={query}
      report={report}
      registered={registered}
      catalogue={catalogue}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

boardRoutes.get("/boards/:id", async (c) => {
  const services = c.get("services");
  const id = parseBoardId(c.req.param("id"));
  if (id === null) return c.notFound();

  const board = await services.boards.get(id);
  if (board === null) return c.notFound();

  const [snapshots, counts] = await Promise.all([
    services.snapshots.recentForBoard(id, 25),
    services.postings.countByBoard(),
  ]);

  return c.html(
    <BoardDetailPage
      board={board}
      snapshots={snapshots}
      counts={counts.get(id) ?? { listed: 0, total: 0 }}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
    />,
  );
});

/** Fetch a single board. Shares the collection use-case, scoped to one id. */
boardRoutes.post("/boards/:id/fetch", async (c) => {
  const services = c.get("services");
  const id = parseBoardId(c.req.param("id"));
  if (id === null) return c.notFound();

  const board = await services.boards.get(id);
  if (board === null) return c.notFound();

  const report = await collect({
    boards: services.boards,
    postings: services.postings,
    snapshots: services.snapshots,
    runs: services.runs,
    sourceFor: services.sourceFor,
    clock: services.clock,
    logger: c.get("logger"),
  }, { boardIds: [id], trigger: "manual" });

  const outcome = report.boards[0];
  const message = outcome === undefined
    ? "That board is not active, so it was not fetched."
    : outcome.status === "failed"
    ? `Fetch failed: ${outcome.reason ?? "unknown reason"}`
    : `${outcome.postingsSeen} listed · ${outcome.appeared} new · ${outcome.changed} changed · ` +
      `${outcome.disappeared} no longer listed`;

  const key = outcome?.status === "failed" ? "error" : "notice";
  return c.redirect(`/boards?${key}=${encodeURIComponent(message)}`, 303);
});

boardRoutes.post("/boards/:id/deactivate", async (c) => {
  const id = parseBoardId(c.req.param("id"));
  if (id === null) return c.notFound();
  await c.get("services").boards.deactivate(id);
  return c.redirect("/boards?notice=Board+deactivated.", 303);
});

boardRoutes.post("/boards/:id/activate", async (c) => {
  const services = c.get("services");
  const id = parseBoardId(c.req.param("id"));
  if (id === null) return c.notFound();
  const board = await services.boards.get(id);
  if (board === null) return c.notFound();
  await services.boards.upsert({
    platform: board.platform,
    slug: board.slug,
    companyName: board.companyName,
    active: true,
    tags: board.tags,
    ...(board.notes !== undefined ? { notes: board.notes } : {}),
  });
  return c.redirect("/boards?notice=Board+activated.", 303);
});

boardRoutes.post("/boards/:id/delete", async (c) => {
  const id = parseBoardId(c.req.param("id"));
  if (id === null) return c.notFound();
  await c.get("services").boards.remove(id);
  return c.redirect("/boards?notice=Board+removed.", 303);
});

/** Fetch every active board. The same entry point n8n will call in M6. */
boardRoutes.post("/collect", async (c) => {
  const services = c.get("services");
  const report = await collect({
    boards: services.boards,
    postings: services.postings,
    snapshots: services.snapshots,
    runs: services.runs,
    sourceFor: services.sourceFor,
    clock: services.clock,
    logger: c.get("logger"),
  }, { trigger: "manual" });

  const message = `${report.boardsFetched}/${report.boardsConfigured} boards fetched · ` +
    `${report.postingsNew} new · ${report.postingsChanged} changed · ` +
    `${report.postingsDisappeared} no longer listed` +
    (report.boardsFailed > 0 ? ` · ${report.boardsFailed} failed` : "");

  return c.redirect(`/coverage?notice=${encodeURIComponent(message)}`, 303);
});
