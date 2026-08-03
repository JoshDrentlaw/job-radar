/**
 * Greenhouse board adapter.
 *
 * Endpoint: boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 *
 * Verified against three live boards (657 postings) before this parser was
 * written. What that verification established:
 *
 *   - No pagination. `meta.total` equalled the length of `jobs` at 81, 176 and
 *     400 postings. The whole board arrives in one response.
 *   - `content` is entity-encoded HTML, on every posting without exception,
 *     using exactly the five basic XML entities. Decode once, then parse.
 *   - `first_published` is present and is the real publication date;
 *     `updated_at` is maintained inconsistently and is display metadata only (§6).
 *   - Greenhouse publishes no compensation field. Salary, when mentioned at all,
 *     is prose inside the description. This adapter does not go looking for it:
 *     a parsed number would be a derived guess wearing a source-asserted field.
 *   - The key set varies slightly between boards (`education` appeared on some
 *     postings and not others), so parsing is tolerant of unknown and absent
 *     keys and strict only about the ones it actually uses.
 */

import type { Platform } from "@platform/ids.ts";
import type { BoardSource, FetchResult, SourcePosting } from "@domain/discovery/types.ts";
import { htmlToMarkdown } from "@adapters/html/to-markdown.ts";
import { FetchFailure, type PoliteFetcher } from "./http.ts";

/**
 * Bumped whenever this parser's output could change for identical input.
 * Recorded on every posting it produces (§5).
 */
export const GREENHOUSE_ADAPTER_VERSION = "greenhouse/1";

const BASE_URL = "https://boards-api.greenhouse.io/v1/boards";

export function greenhouseBoardUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}/jobs?content=true`;
}

/** Only the fields this adapter reads. Everything else in the payload is ignored. */
interface GreenhouseJob {
  id?: number | string;
  title?: string;
  content?: string;
  absolute_url?: string;
  first_published?: string | null;
  updated_at?: string | null;
  location?: { name?: string | null } | null;
  departments?: Array<{ name?: string | null }> | null;
  offices?: Array<{ name?: string | null; location?: string | null }> | null;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
  meta?: { total?: number };
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function firstDepartment(job: GreenhouseJob): string | undefined {
  const name = job.departments?.find((d) => typeof d?.name === "string" && d.name.trim() !== "")
    ?.name;
  return name?.trim() ?? undefined;
}

/**
 * Location comes from `location.name`. When it is missing, fall back to the
 * office list — still source-asserted, just a different field of the same
 * response. If neither exists the posting has no location, and the empty string
 * is recorded rather than a guess.
 */
function locationOf(job: GreenhouseJob): string {
  const primary = job.location?.name?.trim();
  if (primary !== undefined && primary !== "") return primary;

  const offices = (job.offices ?? [])
    .map((office) => office?.location?.trim() || office?.name?.trim() || "")
    .filter((value) => value !== "");
  return offices.length > 0 ? [...new Set(offices)].join(" | ") : "";
}

export function parseGreenhouseBoard(payload: unknown, sourceUrl: string): SourcePosting[] {
  if (typeof payload !== "object" || payload === null) {
    throw new FetchFailure("parse", sourceUrl, "Expected a JSON object at the top level.");
  }
  const response = payload as GreenhouseResponse;
  if (!Array.isArray(response.jobs)) {
    throw new FetchFailure("parse", sourceUrl, "Expected a `jobs` array in the response.");
  }

  const postings: SourcePosting[] = [];
  for (const job of response.jobs) {
    const externalId = job?.id === undefined || job.id === null ? "" : String(job.id).trim();
    const title = job?.title?.trim() ?? "";
    const applyUrl = job?.absolute_url?.trim() ?? "";

    // A posting with no id, title or apply URL is not usable and is not
    // repairable by guessing. Skipping it here would hide the problem, so it
    // fails the whole board parse and lands in the coverage ledger as such.
    if (externalId === "" || title === "" || applyUrl === "") {
      throw new FetchFailure(
        "parse",
        sourceUrl,
        `Posting missing a required field (id=${JSON.stringify(job?.id)}, ` +
          `title=${JSON.stringify(job?.title)}, url=${JSON.stringify(job?.absolute_url)}).`,
      );
    }

    const description = htmlToMarkdown(job.content ?? "", { decodeEntitiesFirst: true });
    const department = firstDepartment(job);
    const postedAt = parseDate(job.first_published);

    postings.push({
      externalId,
      title,
      locationRaw: locationOf(job),
      descriptionText: description,
      applyUrl,
      ...(department !== undefined ? { department } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
      // employmentType and compensation are absent from this feed. They stay
      // undefined rather than being inferred from the description.
    });
  }

  return postings;
}

export class GreenhouseSource implements BoardSource {
  readonly platform: Platform = "greenhouse";
  readonly adapterVersion = GREENHOUSE_ADAPTER_VERSION;
  readonly #http: PoliteFetcher;
  readonly #now: () => Date;

  constructor(http: PoliteFetcher, now: () => Date = () => new Date()) {
    this.#http = http;
    this.#now = now;
  }

  async fetchBoard(slug: string): Promise<FetchResult> {
    const sourceUrl = greenhouseBoardUrl(slug);
    const payload = await this.#http.fetchJson<unknown>(sourceUrl);
    // fetchedAt is stamped after the response arrives, so it is an as-of time
    // for data actually in hand (§5).
    const fetchedAt = this.#now();
    return { sourceUrl, fetchedAt, postings: parseGreenhouseBoard(payload, sourceUrl) };
  }
}
