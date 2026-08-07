/** @jsxImportSource hono/jsx */

/**
 * Coverage ledger (§10). A first-class panel, not a log.
 *
 * The blind-spot list is permanent and unconditional. It is here so that no
 * count anywhere in this application can be read as "these are the jobs" rather
 * than "these are the jobs on the boards you added, as of the last successful
 * fetch of each".
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { formatDateTime, Metric, Notice, relativeAge, StatusChip, Tabs } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import {
  type BoardOutcome,
  type CollectionRun,
  DECLARED_BLIND_SPOTS,
} from "@domain/discovery/coverage.ts";
import type { Board } from "@domain/discovery/types.ts";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CoveragePage: FC<{
  runs: readonly CollectionRun[];
  boards: readonly Board[];
  csrfToken: string;
  now: Date;
  notice?: string;
}> = (props) => {
  const latest = props.runs[0];
  const active = props.boards.filter((b) => b.active);
  const stale = active.filter((b) => b.lastFetchStatus !== "ok");

  return (
    <Layout title="Coverage" current="boards" csrfToken={props.csrfToken}>
      <Tabs
        label="Boards sections"
        items={[
          { href: "/boards", label: "Boards" },
          { href: "/coverage", label: "Coverage", current: true },
        ]}
      />
      <div class="page-head">
        <div>
          <h1>Coverage</h1>
          <p class="lede">
            What the last run saw, and — more importantly — what it did not. A count with no
            denominator is a misleading artifact.
          </p>
        </div>
      </div>

      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      <section class="panel">
        <header>
          <h2>Most recent run</h2>
          {latest !== undefined && (
            <span class="chip" title={formatDateTime(latest.startedAt)}>
              {relativeAge(latest.startedAt, props.now)}
            </span>
          )}
        </header>
        {latest === undefined
          ? <p class="empty">No collection run has happened yet.</p>
          : (
            <div class="metrics">
              <Metric
                label="boards configured"
                value={latest.boardsConfigured}
                hint="Active boards selected for this run — the denominator"
              />
              <Metric label="fetched" value={latest.boardsFetched} />
              <Metric label="failed" value={latest.boardsFailed} />
              <Metric label="postings seen" value={latest.postingsSeen} />
              <Metric label="new" value={latest.postingsNew} />
              <Metric label="changed" value={latest.postingsChanged} />
              <Metric
                label="no longer listed"
                value={latest.postingsDisappeared}
                hint="Absent from the feed. Not necessarily filled or closed."
              />
            </div>
          )}
        {latest !== undefined && (
          <p class="panel-note gap-above">
            <a href={`/coverage/runs/${encodeURIComponent(latest.id)}`}>
              Board-by-board detail for this run →
            </a>
          </p>
        )}
      </section>

      {stale.length > 0 && (
        <section class="panel">
          <header>
            <h2>Active boards not currently readable</h2>
          </header>
          <p class="panel-note">
            These boards are configured and expected to contribute, but their most recent fetch did
            not succeed. Anything they list is missing from every count on this site.
          </p>
          <div class="table-scroll gap-above">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Last attempt</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {stale.map((board) => (
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
                    <td>{relativeAge(board.lastFetchAt, props.now)}</td>
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
          <h2>Declared blind spots</h2>
        </header>
        <p class="panel-note">
          Permanent, not a backlog. These are sources this application does not and will not read,
          and they are stated here so that no result set is mistaken for the whole market.
        </p>
        <ul class="blind-spots gap-above">
          {DECLARED_BLIND_SPOTS.map((spot) => (
            <li>
              <span class="blind-spot-name">{spot.name}</span>
              <span class="blind-spot-reason">{spot.reason}</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="panel">
        <header>
          <h2>Run history</h2>
        </header>
        {props.runs.length === 0
          ? <p class="empty">No runs recorded.</p>
          : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Trigger</th>
                    <th class="numeric">Boards</th>
                    <th class="numeric">Failed</th>
                    <th class="numeric">Seen</th>
                    <th class="numeric">New</th>
                    <th class="numeric">Changed</th>
                    <th class="numeric">Unlisted</th>
                  </tr>
                </thead>
                <tbody>
                  {props.runs.map((run) => (
                    <tr key={run.id}>
                      <td title={formatDateTime(run.startedAt)}>
                        <a
                          class="posting-title"
                          href={`/coverage/runs/${encodeURIComponent(run.id)}`}
                        >
                          {relativeAge(run.startedAt, props.now)}
                        </a>
                        {run.finishedAt === null && (
                          <span class="chip warn chip-inline">
                            did not finish
                          </span>
                        )}
                      </td>
                      <td>{run.trigger}</td>
                      <td class="numeric">{run.boardsFetched}/{run.boardsConfigured}</td>
                      <td class="numeric">{run.boardsFailed}</td>
                      <td class="numeric">{run.postingsSeen}</td>
                      <td class="numeric">{run.postingsNew}</td>
                      <td class="numeric">{run.postingsChanged}</td>
                      <td class="numeric">{run.postingsDisappeared}</td>
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

/**
 * One run, board by board.
 *
 * The run row says "9 of 11 boards, 240 postings". This says which two boards
 * are missing from that number and why, and which board the 6 new postings
 * actually came from. Failures sort first because they are the reason the page
 * exists.
 */
const RunDetailPage: FC<{
  run: CollectionRun;
  outcomes: readonly BoardOutcome[];
  csrfToken: string;
  now: Date;
}> = (props) => {
  const failed = props.outcomes.filter((o) => o.status === "failed");
  const missing = props.run.boardsConfigured - props.outcomes.length;

  return (
    <Layout title="Collection run" current="boards" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Collection run</h1>
          <p class="lede">
            Started {formatDateTime(props.run.startedAt)} ({relativeAge(
              props.run.startedAt,
              props.now,
            )}), triggered {props.run.trigger === "scheduled" ? "on a schedule" : "by hand"}.
            {props.run.finishedAt === null
              ? " This run has no finish time recorded — it did not complete."
              : ""}
          </p>
        </div>
        <div class="row">
          <a class="button quiet" href="/coverage">← Coverage</a>
        </div>
      </div>

      <section class="panel">
        <header>
          <h2>Totals</h2>
        </header>
        <div class="metrics">
          <Metric
            label="boards configured"
            value={props.run.boardsConfigured}
            hint="The denominator: active boards selected for this run"
          />
          <Metric label="read" value={props.run.boardsFetched} />
          <Metric label="failed" value={props.run.boardsFailed} />
          <Metric label="postings seen" value={props.run.postingsSeen} />
          <Metric label="new" value={props.run.postingsNew} />
          <Metric label="changed" value={props.run.postingsChanged} />
          <Metric
            label="no longer listed"
            value={props.run.postingsDisappeared}
            hint="Absent from the feed. Not necessarily filled or closed."
          />
        </div>
        {failed.length > 0 && (
          <p class="panel-note gap-above">
            {failed.length === 1 ? "One board" : `${failed.length} boards`}{" "}
            could not be read. Whatever those boards were listing is absent from every number above.
          </p>
        )}
      </section>

      <section class="panel">
        <header>
          <h2>By board</h2>
        </header>
        {props.outcomes.length === 0
          ? (
            <p class="empty">
              No per-board detail was recorded for this run. Runs collected before this view existed
              kept only their totals.
            </p>
          )
          : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Result</th>
                    <th class="numeric">Seen</th>
                    <th class="numeric">New</th>
                    <th class="numeric">Changed</th>
                    <th class="numeric">Unlisted</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {props.outcomes.map((outcome) => (
                    <tr key={outcome.boardId}>
                      <td>
                        <a
                          class="posting-title"
                          href={`/boards/${encodeURIComponent(outcome.boardId)}`}
                        >
                          {outcome.companyName}
                        </a>
                      </td>
                      <td>
                        <StatusChip status={outcome.status} />
                      </td>
                      <td class="numeric">
                        {outcome.status === "ok" ? outcome.postingsSeen : "—"}
                      </td>
                      <td class="numeric">{outcome.status === "ok" ? outcome.appeared : "—"}</td>
                      <td class="numeric">{outcome.status === "ok" ? outcome.changed : "—"}</td>
                      <td class="numeric">{outcome.status === "ok" ? outcome.disappeared : "—"}</td>
                      <td class="field-hint">{outcome.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {missing > 0 && (
          <p class="panel-note gap-above">
            {missing} of the {props.run.boardsConfigured}{" "}
            configured boards has no row here. That is a gap in the record itself, not a board that
            returned nothing.
          </p>
        )}
      </section>
    </Layout>
  );
};

export const coverageRoutes = new Hono<AppEnv>();

coverageRoutes.get("/coverage", async (c) => {
  const services = c.get("services");
  const [runs, boards] = await Promise.all([
    services.runs.recent(25),
    services.boards.list(),
  ]);
  const notice = c.req.query("notice");
  return c.html(
    <CoveragePage
      runs={runs}
      boards={boards}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

coverageRoutes.get("/coverage/runs/:id", async (c) => {
  const services = c.get("services");
  const id = c.req.param("id") ?? "";
  // Run ids are uuids. Anything else is a 404, not a cast error at the database.
  if (!UUID.test(id)) return c.text("Not found.", 404);
  const run = await services.runs.get(id);
  if (run === null) return c.text("Not found.", 404);

  const outcomes = await services.runs.boardOutcomes(run.id);
  return c.html(
    <RunDetailPage
      run={run}
      outcomes={outcomes}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
    />,
  );
});
