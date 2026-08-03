/**
 * Lever board adapter.
 *
 * Endpoint: api.lever.co/v0/postings/{slug}?mode=json
 *
 * Verified against two live boards (Spotify and Veeva, 890 postings) plus one
 * live empty board before this parser was written. What that verification
 * established:
 *
 *   - The response is a bare JSON array, no envelope, no pagination. An empty
 *     board is `[]`, which is a valid answer and not an error.
 *   - The key set was identical on all 890 postings: id, text, description,
 *     descriptionPlain, descriptionBody, opening, lists, additional,
 *     additionalPlain, categories, createdAt, country, workplaceType,
 *     hostedUrl, applyUrl. Parsing is still tolerant of absent keys — two
 *     boards is not every board.
 *   - The description is split across three HTML fields: `description` (the
 *     intro), `lists[]` ({text: heading, content: <li> fragments}), and
 *     `additional` (the closing boilerplate). All three must be concatenated
 *     or the requirements — which live almost entirely in `lists` — are lost.
 *   - The HTML is real HTML, not entity-encoded like Greenhouse's.
 *   - `workplaceType` is a source-asserted modality: 'remote' | 'hybrid' |
 *     'onsite' on every posting observed. It feeds `workplaceRaw`.
 *   - `categories.commitment` ("Permanent", "Full-time") is the employment
 *     type and was absent on 7 of 104 Spotify postings — genuinely optional.
 *   - `createdAt` is epoch milliseconds.
 *   - `salaryRange` appeared on zero of 890 postings. Lever documents the
 *     field, but a parser for a shape never observed live would violate the
 *     verify-first rule (§4), so compensation stays unset until a live board
 *     shows one.
 */

import type { Platform } from "@platform/ids.ts";
import type { BoardSource, FetchResult, SourcePosting } from "@domain/discovery/types.ts";
import { htmlToMarkdown } from "@adapters/html/to-markdown.ts";
import { FetchFailure, type PoliteFetcher } from "./http.ts";

/**
 * Bumped whenever this parser's output could change for identical input.
 * Recorded on every posting it produces (§5).
 */
export const LEVER_ADAPTER_VERSION = "lever/1";

const BASE_URL = "https://api.lever.co/v0/postings";

export function leverBoardUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}?mode=json`;
}

/** Only the fields this adapter reads. Everything else in the payload is ignored. */
interface LeverPosting {
  id?: string;
  text?: string;
  description?: string;
  lists?: Array<{ text?: string | null; content?: string | null }> | null;
  additional?: string;
  categories?: {
    commitment?: string | null;
    department?: string | null;
    location?: string | null;
    allLocations?: string[] | null;
  } | null;
  createdAt?: number;
  workplaceType?: string | null;
  hostedUrl?: string;
}

function parseEpochMillis(value: number | undefined): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * `categories.location` is the primary location; `categories.allLocations`
 * carries the rest for multi-location postings. Union of both, joined the same
 * way the Greenhouse adapter joins offices — still source-asserted, just more
 * than one field of the same response.
 */
function locationOf(posting: LeverPosting): string {
  const parts = [
    posting.categories?.location ?? "",
    ...(posting.categories?.allLocations ?? []),
  ]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "");
  return [...new Set(parts)].join(" | ");
}

/**
 * Reassemble the split description in the order Lever's own hosted page renders
 * it: intro, then each list under its heading, then the closing block. The list
 * content is a run of bare `<li>` fragments, so it gets its `<ul>` back before
 * conversion.
 */
function descriptionHtmlOf(posting: LeverPosting): string {
  const sections: string[] = [];
  const intro = posting.description?.trim() ?? "";
  if (intro !== "") sections.push(intro);

  for (const list of posting.lists ?? []) {
    const heading = list?.text?.trim() ?? "";
    const content = list?.content?.trim() ?? "";
    if (heading === "" && content === "") continue;
    if (heading !== "") sections.push(`<h3>${heading}</h3>`);
    if (content !== "") sections.push(`<ul>${content}</ul>`);
  }

  const additional = posting.additional?.trim() ?? "";
  if (additional !== "") sections.push(additional);

  return sections.join("\n");
}

export function parseLeverBoard(payload: unknown, sourceUrl: string): SourcePosting[] {
  // A bare array, unlike every other feed so far. `[]` is an empty board, not
  // a failure — one was observed live.
  if (!Array.isArray(payload)) {
    throw new FetchFailure("parse", sourceUrl, "Expected a JSON array at the top level.");
  }

  const postings: SourcePosting[] = [];
  for (const raw of payload as LeverPosting[]) {
    const externalId = raw?.id?.trim() ?? "";
    const title = raw?.text?.trim() ?? "";
    const applyUrl = raw?.hostedUrl?.trim() ?? "";

    // A posting with no id, title or apply URL is not usable and is not
    // repairable by guessing. Skipping it here would hide the problem, so it
    // fails the whole board parse and lands in the coverage ledger as such.
    if (externalId === "" || title === "" || applyUrl === "") {
      throw new FetchFailure(
        "parse",
        sourceUrl,
        `Posting missing a required field (id=${JSON.stringify(raw?.id)}, ` +
          `text=${JSON.stringify(raw?.text)}, hostedUrl=${JSON.stringify(raw?.hostedUrl)}).`,
      );
    }

    const workplaceRaw = raw.workplaceType?.trim() ?? "";
    const employmentType = raw.categories?.commitment?.trim() ?? "";
    const department = raw.categories?.department?.trim() ?? "";
    const postedAt = parseEpochMillis(raw.createdAt);

    postings.push({
      externalId,
      title,
      locationRaw: locationOf(raw),
      descriptionText: htmlToMarkdown(descriptionHtmlOf(raw)),
      applyUrl,
      ...(workplaceRaw !== "" ? { workplaceRaw } : {}),
      ...(employmentType !== "" ? { employmentType } : {}),
      ...(department !== "" ? { department } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
      // compensation stays undefined: salaryRange has never been observed live
      // (see the module comment), and prose salaries in descriptions are not
      // this adapter's to guess at.
    });
  }

  return postings;
}

export class LeverSource implements BoardSource {
  readonly platform: Platform = "lever";
  readonly adapterVersion = LEVER_ADAPTER_VERSION;
  readonly #http: PoliteFetcher;
  readonly #now: () => Date;

  constructor(http: PoliteFetcher, now: () => Date = () => new Date()) {
    this.#http = http;
    this.#now = now;
  }

  async fetchBoard(slug: string): Promise<FetchResult> {
    const sourceUrl = leverBoardUrl(slug);
    const payload = await this.#http.fetchJson<unknown>(sourceUrl);
    // fetchedAt is stamped after the response arrives, so it is an as-of time
    // for data actually in hand (§5).
    const fetchedAt = this.#now();
    return { sourceUrl, fetchedAt, postings: parseLeverBoard(payload, sourceUrl) };
  }
}
