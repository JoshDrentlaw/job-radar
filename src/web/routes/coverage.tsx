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
import { formatDateTime, Metric, Notice, relativeAge, StatusChip } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { type CollectionRun, DECLARED_BLIND_SPOTS } from "@domain/discovery/coverage.ts";
import type { Board } from "@domain/discovery/types.ts";

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
    <Layout title="Coverage" current="coverage" csrfToken={props.csrfToken}>
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
                    <tr>
                      <td title={formatDateTime(run.startedAt)}>
                        {relativeAge(run.startedAt, props.now)}
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
