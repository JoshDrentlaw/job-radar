/** @jsxImportSource hono/jsx */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, Metric, relativeAge, StatusChip } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { Board, Posting } from "@domain/discovery/types.ts";
import type { CollectionRun } from "@domain/discovery/coverage.ts";
import type { BoardId } from "@platform/ids.ts";

const Dashboard: FC<{
  boards: readonly Board[];
  counts: Map<BoardId, { listed: number; total: number }>;
  recent: readonly Posting[];
  latestRun: CollectionRun | undefined;
  csrfToken: string;
  now: Date;
}> = (props) => {
  const active = props.boards.filter((b) => b.active);
  const failing = active.filter((b) => b.lastFetchStatus === "failed");
  const totals = [...props.counts.values()].reduce(
    (acc, c) => ({ listed: acc.listed + c.listed, total: acc.total + c.total }),
    { listed: 0, total: 0 },
  );
  const companyById = new Map(props.boards.map((b) => [b.id as string, b.companyName]));

  return (
    <Layout title="Dashboard" current="dashboard" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Dashboard</h1>
          <p class="lede">
            {active.length} active board{active.length === 1 ? "" : "s"}.{" "}
            {props.latestRun === undefined
              ? "Nothing has been collected yet."
              : `Last collected ${relativeAge(props.latestRun.startedAt, props.now)}.`}
          </p>
        </div>
        <form method="post" action="/collect">
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="primary">Collect now</button>
        </form>
      </div>

      <section class="panel">
        <header>
          <h2>Current holdings</h2>
          <a href="/coverage" class="button quiet">What is this missing?</a>
        </header>
        <div class="metrics">
          <Metric label="active boards" value={active.length} />
          <Metric label="postings listed" value={totals.listed} />
          <Metric
            label="postings ever seen"
            value={totals.total}
            hint="Includes postings no longer listed. History is kept."
          />
          <Metric label="boards failing" value={failing.length} />
        </div>
      </section>

      {failing.length > 0 && (
        <section class="panel">
          <header>
            <h2>Boards needing attention</h2>
          </header>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {failing.map((board) => (
                  <tr>
                    <td>
                      <a class="posting-title" href={`/boards/${encodeURIComponent(board.id)}`}>
                        {board.companyName}
                      </a>
                    </td>
                    <td>
                      <StatusChip
                        status={board.lastFetchStatus}
                        failures={board.consecutiveFailures}
                      />
                    </td>
                    <td class="field-hint">{board.lastFetchError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section class="panel">
        <header>
          <h2>Most recently seen</h2>
          <a href="/postings" class="button quiet">All postings</a>
        </header>
        {props.recent.length === 0
          ? <p class="empty">No postings collected yet. Add a board and run a collection.</p>
          : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Company</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {props.recent.map((posting) => (
                    <tr>
                      <td>
                        <a
                          class="posting-title"
                          href={`/postings/${encodeURIComponent(posting.id)}`}
                        >
                          {posting.title}
                        </a>
                      </td>
                      <td>{companyById.get(posting.boardId) ?? posting.boardId}</td>
                      <td>{posting.locationRaw || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </Layout>
  );
};

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  const services = c.get("services");
  const [boards, counts, recent, runs] = await Promise.all([
    services.boards.list(),
    services.postings.countByBoard(),
    services.postings.list({ limit: 10 }),
    services.runs.recent(1),
  ]);

  return c.html(
    <Dashboard
      boards={boards}
      counts={counts}
      recent={recent.postings}
      latestRun={runs[0]}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
    />,
  );
});
