/**
 * Ashby board adapter.
 *
 * Endpoint: api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *
 * Verified against four live boards (Linear, Ramp, OpenAI, Modal — 931
 * postings) before this parser was written. What that verification established:
 *
 *   - One response, no pagination, envelope `{ jobs: [...], apiVersion: "1" }`.
 *     The key set was identical on all 931 postings.
 *   - `descriptionHtml` is real HTML, not entity-encoded.
 *   - `workplaceType` is a source-asserted modality: 'Remote' | 'Hybrid' |
 *     'OnSite', null on 262 postings. `isRemote` is lossy alongside it (true
 *     for Hybrid too) and is ignored.
 *   - Compensation is the best of any feed, as the brief predicted (§4), and it
 *     nests inconsistently on paper — so both documented locations are read:
 *     top-level `summaryComponents` first, `compensationTiers[].components` as
 *     the fallback. Live, every posting with tiers also had summaryComponents,
 *     but four boards is not every board.
 *   - `summaryComponents[].currencyCode` was absent (not null — absent) on 64
 *     of 1523 components. Absent means unstated, not USD.
 *   - Salary is one component among EquityCashValue, EquityPercentage,
 *     Commission and Bonus. Only Salary maps to the structured min/max; the
 *     source's own `compensationTierSummary` wording is kept as `raw`.
 *   - Two postings had `shouldDisplayCompensationOnJobPostings: true` with no
 *     compensation data; zero had data with the flag false. The data's
 *     presence tracks the flag, so the flag is not consulted.
 *   - `isListed` was true on every posting observed, but the field exists, so
 *     unlisted rows are dropped rather than recorded as live listings.
 */

import type { Platform } from "@platform/ids.ts";
import type {
  BoardSource,
  Compensation,
  FetchResult,
  SourcePosting,
} from "@domain/discovery/types.ts";
import { htmlToMarkdown } from "@adapters/html/to-markdown.ts";
import { FetchFailure, type PoliteFetcher } from "./http.ts";

/**
 * Bumped whenever this parser's output could change for identical input.
 * Recorded on every posting it produces (§5).
 */
export const ASHBY_ADAPTER_VERSION = "ashby/1";

const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";

export function ashbyBoardUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}?includeCompensation=true`;
}

/** Only the fields this adapter reads. Everything else in the payload is ignored. */
interface AshbyCompensationComponent {
  compensationType?: string | null;
  interval?: string | null;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyCompensation {
  compensationTierSummary?: string | null;
  summaryComponents?: AshbyCompensationComponent[] | null;
  compensationTiers?: Array<{ components?: AshbyCompensationComponent[] | null }> | null;
}

interface AshbyJob {
  id?: string;
  title?: string;
  department?: string | null;
  employmentType?: string | null;
  location?: string | null;
  secondaryLocations?: Array<{ location?: string | null }> | null;
  publishedAt?: string | null;
  isListed?: boolean;
  workplaceType?: string | null;
  jobUrl?: string;
  descriptionHtml?: string;
  compensation?: AshbyCompensation | null;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Measured live: '1 YEAR' (1476), 'NONE' (43), '1 MONTH' (2), '1 HOUR' (2). */
const INTERVALS: ReadonlyMap<string, NonNullable<Compensation["interval"]>> = new Map([
  ["1 YEAR", "year"],
  ["1 MONTH", "month"],
  ["1 WEEK", "week"],
  ["1 DAY", "day"],
  ["1 HOUR", "hour"],
]);

/**
 * Both documented nesting locations are consulted: `summaryComponents` first,
 * every tier's `components` as the fallback. Only the Salary component becomes
 * the structured range; everything else (equity, commission, bonus) is covered
 * by the source's own `compensationTierSummary` wording, kept verbatim in
 * `raw`. An unrecognized structure with a summary still yields `{ raw }` —
 * better the source's sentence than nothing.
 */
export function parseAshbyCompensation(
  comp: AshbyCompensation | null | undefined,
): Compensation | undefined {
  if (comp === null || comp === undefined) return undefined;

  const summary = comp.compensationTierSummary?.trim() ?? "";
  const components = (comp.summaryComponents?.length ?? 0) > 0
    ? comp.summaryComponents!
    : (comp.compensationTiers ?? []).flatMap((tier) => tier?.components ?? []);

  const salaries = components.filter((c) => c?.compensationType === "Salary");
  const minimums = salaries
    .map((c) => c.minValue)
    .filter((v): v is number => typeof v === "number");
  const maximums = salaries
    .map((c) => c.maxValue)
    .filter((v): v is number => typeof v === "number");
  const currency = salaries.map((c) => c.currencyCode).find((c): c is string =>
    typeof c === "string" && c !== ""
  );
  const interval = salaries
    .map((c) => INTERVALS.get(c.interval ?? ""))
    .find((v) => v !== undefined);

  if (minimums.length === 0 && maximums.length === 0 && summary === "") return undefined;

  return {
    ...(minimums.length > 0 ? { minAmount: Math.min(...minimums) } : {}),
    ...(maximums.length > 0 ? { maxAmount: Math.max(...maximums) } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(interval !== undefined ? { interval } : {}),
    ...(summary !== "" ? { raw: summary } : {}),
  };
}

/** Primary location plus the secondaries, joined as the other adapters join theirs. */
function locationOf(job: AshbyJob): string {
  const parts = [
    job.location ?? "",
    ...(job.secondaryLocations ?? []).map((s) => s?.location ?? ""),
  ]
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return [...new Set(parts)].join(" | ");
}

export function parseAshbyBoard(payload: unknown, sourceUrl: string): SourcePosting[] {
  if (typeof payload !== "object" || payload === null) {
    throw new FetchFailure("parse", sourceUrl, "Expected a JSON object at the top level.");
  }
  const response = payload as AshbyResponse;
  if (!Array.isArray(response.jobs)) {
    throw new FetchFailure("parse", sourceUrl, "Expected a `jobs` array in the response.");
  }

  const postings: SourcePosting[] = [];
  for (const job of response.jobs) {
    // The feed says this posting is not listed; recording it as a live listing
    // would be asserting something the source did not.
    if (job?.isListed === false) continue;

    const externalId = job?.id?.trim() ?? "";
    const title = job?.title?.trim() ?? "";
    const applyUrl = job?.jobUrl?.trim() ?? "";

    // A posting with no id, title or apply URL is not usable and is not
    // repairable by guessing. Skipping it here would hide the problem, so it
    // fails the whole board parse and lands in the coverage ledger as such.
    if (externalId === "" || title === "" || applyUrl === "") {
      throw new FetchFailure(
        "parse",
        sourceUrl,
        `Posting missing a required field (id=${JSON.stringify(job?.id)}, ` +
          `title=${JSON.stringify(job?.title)}, jobUrl=${JSON.stringify(job?.jobUrl)}).`,
      );
    }

    const workplaceRaw = job.workplaceType?.trim() ?? "";
    const employmentType = job.employmentType?.trim() ?? "";
    const department = job.department?.trim() ?? "";
    const postedAt = parseDate(job.publishedAt);
    const compensation = parseAshbyCompensation(job.compensation);

    postings.push({
      externalId,
      title,
      locationRaw: locationOf(job),
      descriptionText: htmlToMarkdown(job.descriptionHtml ?? ""),
      applyUrl,
      ...(workplaceRaw !== "" ? { workplaceRaw } : {}),
      ...(employmentType !== "" ? { employmentType } : {}),
      ...(department !== "" ? { department } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(compensation !== undefined ? { compensation } : {}),
    });
  }

  return postings;
}

export class AshbySource implements BoardSource {
  readonly platform: Platform = "ashby";
  readonly adapterVersion = ASHBY_ADAPTER_VERSION;
  readonly #http: PoliteFetcher;
  readonly #now: () => Date;

  constructor(http: PoliteFetcher, now: () => Date = () => new Date()) {
    this.#http = http;
    this.#now = now;
  }

  async fetchBoard(slug: string): Promise<FetchResult> {
    const sourceUrl = ashbyBoardUrl(slug);
    const payload = await this.#http.fetchJson<unknown>(sourceUrl);
    // fetchedAt is stamped after the response arrives, so it is an as-of time
    // for data actually in hand (§5).
    const fetchedAt = this.#now();
    return { sourceUrl, fetchedAt, postings: parseAshbyBoard(payload, sourceUrl) };
  }
}
