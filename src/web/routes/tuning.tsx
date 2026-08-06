/** @jsxImportSource hono/jsx */

/**
 * Tuning (§7). The one place raw similarity floats appear.
 *
 * Thresholds should be set where the score distribution actually separates,
 * not where 0.78 feels right — so this page shows the distribution across all
 * scored pairs, exports it as CSV, and edits the thresholds stored in
 * app.settings.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, Field, Metric, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import {
  BUCKET_THRESHOLDS_SETTING,
  type BucketThresholds,
  loadBucketThresholds,
  type ScoreRow,
  ThresholdError,
  validateThresholds,
} from "@domain/discovery/matching.ts";

const BIN_COUNT = 24;
/** Cosine similarity of prose embeddings in practice; scores land inside this. */
const HISTOGRAM_MIN = 0;
const HISTOGRAM_MAX = 1;

interface Bin {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

function histogram(scores: readonly number[]): Bin[] {
  const width = (HISTOGRAM_MAX - HISTOGRAM_MIN) / BIN_COUNT;
  const counts = new Array<number>(BIN_COUNT).fill(0);
  for (const score of scores) {
    const clamped = Math.min(Math.max(score, HISTOGRAM_MIN), HISTOGRAM_MAX - 1e-9);
    counts[Math.floor((clamped - HISTOGRAM_MIN) / width)]! += 1;
  }
  return counts.map((count, i) => ({
    from: HISTOGRAM_MIN + i * width,
    to: HISTOGRAM_MIN + (i + 1) * width,
    count,
  }));
}

const Histogram: FC<{ bins: readonly Bin[]; thresholds: BucketThresholds }> = (props) => {
  const peak = Math.max(1, ...props.bins.map((b) => b.count));
  return (
    <div class="histogram" role="img" aria-label="Distribution of match scores">
      {props.bins.map((bin) => {
        const region = bin.from >= props.thresholds.strong
          ? "strong"
          : bin.from >= props.thresholds.plausible
          ? "plausible"
          : "weak";
        return (
          <div
            class={`histogram-bar ${region}`}
            title={`${bin.from.toFixed(2)}–${bin.to.toFixed(2)}: ${bin.count} pair${
              bin.count === 1 ? "" : "s"
            }`}
          >
            <div class="histogram-fill" style={`height: ${(bin.count / peak) * 100}%`}></div>
          </div>
        );
      })}
    </div>
  );
};

const TuningPage: FC<{
  scores: readonly ScoreRow[];
  thresholds: BucketThresholds;
  csrfToken: string;
  notice?: string;
  error?: string;
}> = (props) => {
  const values = props.scores.map((s) => s.score);
  const inBucket = (predicate: (v: number) => boolean) => values.filter(predicate).length;
  const strongCount = inBucket((v) => v >= props.thresholds.strong);
  const plausibleCount = inBucket((v) =>
    v >= props.thresholds.plausible && v < props.thresholds.strong
  );
  const weakCount = values.length - strongCount - plausibleCount;

  return (
    <Layout title="Tuning" current="tuning" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Match tuning</h1>
          <p class="lede">
            Raw similarity scores across every scored (posting, facet) pair. Set the bucket
            thresholds where this distribution separates; everywhere else in the app shows buckets
            only.
          </p>
        </div>
        <a class="button quiet" href="/tuning/scores.csv" download="job-radar-scores.csv">
          Export CSV
        </a>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      <section class="panel">
        <header>
          <h2>Distribution</h2>
        </header>
        {values.length === 0
          ? (
            <p class="empty">
              No scored pairs yet. Add profile facets and refresh matches first; tuning without a
              distribution is guessing.
            </p>
          )
          : (
            <>
              <Histogram bins={histogram(values)} thresholds={props.thresholds} />
              <p class="field-hint">
                {HISTOGRAM_MIN.toFixed(1)} on the left, {HISTOGRAM_MAX.toFixed(1)}{" "}
                on the right. Coloring shows which bucket each bin falls into under the current
                thresholds.
              </p>
              <div class="metrics gap-above">
                <Metric label="scored pairs" value={values.length} />
                <Metric label="strong" value={strongCount} />
                <Metric label="plausible" value={plausibleCount} />
                <Metric label="weak" value={weakCount} />
              </div>
            </>
          )}
      </section>

      <section class="panel stack">
        <header>
          <h2>Bucket thresholds</h2>
        </header>
        <form method="post" action="/tuning/thresholds" class="stack">
          <CsrfField token={props.csrfToken} />
          <div class="field-row">
            <Field label="Strong at or above" for="strong">
              <input
                id="strong"
                name="strong"
                type="number"
                step="0.01"
                min="-1"
                max="1"
                value={String(props.thresholds.strong)}
                required
              />
            </Field>
            <Field
              label="Plausible at or above"
              for="plausible"
              hint="Anything below this is weak."
            >
              <input
                id="plausible"
                name="plausible"
                type="number"
                step="0.01"
                min="-1"
                max="1"
                value={String(props.thresholds.plausible)}
                required
              />
            </Field>
          </div>
          <p class="field-hint">
            Changing thresholds re-buckets existing scores immediately; nothing is re-scored.
          </p>
          <div class="row">
            <button type="submit" class="primary">Save thresholds</button>
          </div>
        </form>
      </section>
    </Layout>
  );
};

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const tuningRoutes = new Hono<AppEnv>();

tuningRoutes.get("/tuning", async (c) => {
  const services = c.get("services");
  const [scores, thresholds] = await Promise.all([
    services.matches.allScores(),
    loadBucketThresholds(services.settings),
  ]);
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <TuningPage
      scores={scores}
      thresholds={thresholds}
      csrfToken={c.get("csrfToken")}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

tuningRoutes.get("/tuning/scores.csv", async (c) => {
  const scores = await c.get("services").matches.allScores();
  const lines = ["posting_id,title,company,facet,score,scored_at"];
  for (const row of scores) {
    lines.push(
      [
        csvField(row.postingId),
        csvField(row.title),
        csvField(row.companyName),
        csvField(row.facetName),
        row.score.toFixed(6),
        row.scoredAt.toISOString(),
      ].join(","),
    );
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="job-radar-scores.csv"');
  return c.body(lines.join("\r\n") + "\r\n");
});

tuningRoutes.post("/tuning/thresholds", async (c) => {
  const body = await c.req.parseBody();
  const strong = Number(typeof body.strong === "string" ? body.strong : NaN);
  const plausible = Number(typeof body.plausible === "string" ? body.plausible : NaN);

  let thresholds: BucketThresholds;
  try {
    thresholds = validateThresholds(strong, plausible);
  } catch (error) {
    if (error instanceof ThresholdError) {
      return c.redirect(`/tuning?error=${encodeURIComponent(error.message)}`, 303);
    }
    throw error;
  }

  await c.get("services").settings.set(BUCKET_THRESHOLDS_SETTING, thresholds);
  return c.redirect(
    `/tuning?notice=${encodeURIComponent("Thresholds saved. Match views re-bucket immediately.")}`,
    303,
  );
});
