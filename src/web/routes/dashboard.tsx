/** @jsxImportSource hono/jsx */

/**
 * The dashboard.
 *
 * Six milestones in, this page had never been revisited: it knew about boards
 * and postings and nothing about matching, tailoring or applications, which is
 * most of what the application now does. The organising question is "what is
 * waiting for me?", and everything below either answers it or gets out of the
 * way — panels with nothing in them do not render.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, Metric, relativeAge, StatusChip } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { Board, Posting } from "@domain/discovery/types.ts";
import type { CollectionRun } from "@domain/discovery/coverage.ts";
import type { PendingRun } from "@domain/dossier/proposals.ts";
import {
  type ApplicationStatus,
  type ApplicationSummary,
  AWAITING_STATUSES,
  DEFAULT_GHOST_AFTER_DAYS,
  GHOST_AFTER_DAYS_SETTING,
} from "@domain/pipeline/types.ts";
import {
  bucketOf,
  type BucketThresholds,
  loadBucketThresholds,
  type MatchCandidate,
} from "@domain/discovery/matching.ts";
import type { BoardId } from "@platform/ids.ts";

/** One thing waiting for the user, with the link that resolves it. */
export interface Waiting {
  readonly what: string;
  readonly detail: string;
  readonly href: string;
  readonly urgent: boolean;
}

const Dashboard: FC<{
  boards: readonly Board[];
  counts: Map<BoardId, { listed: number; total: number }>;
  recent: readonly Posting[];
  latestRun: CollectionRun | undefined;
  waiting: readonly Waiting[];
  buckets: { strong: number; plausible: number; weak: number };
  matchingEnabled: boolean;
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
          <h2>Waiting for you</h2>
        </header>
        {props.waiting.length === 0
          ? (
            <p class="empty">
              Nothing is waiting. Postings arrive on their own; matches follow them.
            </p>
          )
          : (
            <ul class="waiting">
              {props.waiting.map((item) => (
                <li key={item.href} class={item.urgent ? "urgent" : ""}>
                  <a class="posting-title" href={item.href}>{item.what}</a>
                  <span class="field-hint">{item.detail}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section class="panel">
        <header>
          <h2>Matches</h2>
          <a href="/matches" class="button quiet">Browse</a>
        </header>
        {!props.matchingEnabled
          ? (
            <p class="empty">
              Matching is off — no embedding API key is configured. Boards and postings work without
              it.
            </p>
          )
          : (
            <div class="metrics">
              <Metric label="strong" value={props.buckets.strong} />
              <Metric label="plausible" value={props.buckets.plausible} />
              <Metric
                label="weak"
                value={props.buckets.weak}
                hint="Where the vocabulary gaps usually are"
              />
            </div>
          )}
      </section>

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
                  <tr key={board.id}>
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
                    <tr key={posting.id}>
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

/**
 * What is actually waiting, in the order it should be dealt with: things a
 * model produced and nobody has read yet, then things half-finished, then
 * things that have gone quiet, then the plumbing.
 */
export function whatIsWaiting(input: {
  pendingRuns: readonly PendingRun[];
  applications: Map<ApplicationStatus, number>;
  awaiting: readonly ApplicationSummary[];
  failingBoards: number;
  now: Date;
  ghostAfterDays: number;
}): Waiting[] {
  const waiting: Waiting[] = [];

  const pending = input.pendingRuns.reduce((total, run) => total + run.pending, 0);
  const flagged = input.pendingRuns.reduce((total, run) => total + run.flagged, 0);
  if (pending > 0) {
    const first = input.pendingRuns[0]!;
    waiting.push({
      what: `${pending} proposed rewrite${pending === 1 ? "" : "s"} awaiting review`,
      detail: flagged > 0
        ? `${flagged} flagged for drift. Nothing reaches a variant until you accept it.`
        : "Nothing reaches a variant until you accept it.",
      href: `/dossier/runs/${encodeURIComponent(first.runId)}`,
      urgent: flagged > 0,
    });
  }

  const drafting = input.applications.get("drafting") ?? 0;
  if (drafting > 0) {
    waiting.push({
      what: `${drafting} application${drafting === 1 ? "" : "s"} still drafting`,
      detail: "Started, not sent. Nothing here submits anything for you.",
      href: "/applications",
      urgent: false,
    });
  }

  // Quiet but not yet stale: the window is about to close on these.
  const soon = input.awaiting.filter((application) => {
    const days = (input.now.getTime() - application.lastActivityAt.getTime()) / 86_400_000;
    return days >= input.ghostAfterDays * 0.75 && days < input.ghostAfterDays;
  });
  if (soon.length > 0) {
    waiting.push({
      what: `${soon.length} application${soon.length === 1 ? "" : "s"} going quiet`,
      detail:
        `No activity for most of the ${input.ghostAfterDays}-day window. That says nothing about ` +
        `the employer — only that nothing has happened.`,
      href: "/applications",
      urgent: false,
    });
  }

  const ghosted = input.applications.get("ghosted") ?? 0;
  if (ghosted > 0) {
    waiting.push({
      what: `${ghosted} application${ghosted === 1 ? "" : "s"} marked ghosted`,
      detail: "Silence past the window. Close them out, or log something that happened.",
      href: "/applications",
      urgent: false,
    });
  }

  if (input.failingBoards > 0) {
    waiting.push({
      what: `${input.failingBoards} board${input.failingBoards === 1 ? "" : "s"} cannot be read`,
      detail: "Whatever they are listing is missing from every count on this site.",
      href: "/coverage",
      urgent: true,
    });
  }

  return waiting;
}

function bucketCounts(
  candidates: readonly MatchCandidate[],
  thresholds: BucketThresholds,
): { strong: number; plausible: number; weak: number } {
  const counts = { strong: 0, plausible: 0, weak: 0 };
  // One posting can match several facets; the strongest is the one that counts.
  const best = new Map<string, number>();
  for (const candidate of candidates) {
    const current = best.get(candidate.postingId);
    if (current === undefined || candidate.score > current) {
      best.set(candidate.postingId, candidate.score);
    }
  }
  for (const score of best.values()) counts[bucketOf(score, thresholds)]++;
  return counts;
}

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  const services = c.get("services");
  const now = services.clock.now();

  const [boards, counts, recent, runs, pendingRuns, byStatus, awaiting, thresholds, candidates] =
    await Promise.all([
      services.boards.list(),
      services.postings.countByBoard(),
      services.postings.list({ limit: 10 }),
      services.runs.recent(1),
      services.tailoring.pendingRuns(),
      services.applications.countByStatus(),
      services.applications.list({}),
      loadBucketThresholds(services.settings),
      services.matches.listCandidates({}),
    ]);

  const ghostAfterDays = await services.settings.get<number>(GHOST_AFTER_DAYS_SETTING) ??
    DEFAULT_GHOST_AFTER_DAYS;

  return c.html(
    <Dashboard
      boards={boards}
      counts={counts}
      recent={recent.postings}
      latestRun={runs[0]}
      waiting={whatIsWaiting({
        pendingRuns,
        applications: byStatus,
        awaiting: awaiting.filter((application) => AWAITING_STATUSES.has(application.status)),
        failingBoards: boards.filter((b) => b.active && b.lastFetchStatus === "failed").length,
        now,
        ghostAfterDays,
      })}
      buckets={bucketCounts(candidates, thresholds)}
      matchingEnabled={services.embedder !== null}
      csrfToken={c.get("csrfToken")}
      now={now}
    />,
  );
});
