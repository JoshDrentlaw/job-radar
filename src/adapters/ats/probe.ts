/**
 * "Is there a board at this name?" — asked of each platform in the cheapest way
 * it will answer.
 *
 * All three answer 404 for a name that is not a board and 200 for one that is,
 * without authentication. Measured against live endpoints before this was
 * written, because the cost of a probe decides whether speculative probing is
 * defensible at all:
 *
 *   greenhouse  GET /v1/boards/{slug}                  28 bytes, and it states
 *                                                      the company's own name
 *   lever       GET /v0/postings/{slug}?mode=json&limit=1
 *                                                      ~10 KB, against ~1 MB
 *                                                      for the unlimited feed
 *   ashby       GET /posting-api/job-board/{slug}      tiny on a miss; the full
 *                                                      board on a hit
 *
 * Ashby has no cheaper existence check than the board itself — a HEAD would
 * do it in zero bytes, but the polite fetcher only issues GETs and widening it
 * for one caller is not worth the change to a file every adapter depends on. A
 * miss, which is the common case while guessing, costs nothing either way.
 *
 * Nothing here parses postings. A confirmed hit is read by the platform's real
 * adapter, so the count and titles shown come from the same code path that will
 * collect the board for real — which makes the preview a rehearsal rather than
 * a second opinion.
 */

import type { Platform } from "@platform/ids.ts";
import { FetchFailure, type PoliteFetcher } from "./http.ts";

export interface ProbeResult {
  readonly found: boolean;
  /** Stated by the platform, where it states one. Only Greenhouse does. */
  readonly companyName?: string;
  /** Set when we could not find out, as opposed to finding out there is nothing. */
  readonly error?: string;
}

export function probeUrl(platform: Platform, slug: string): string | null {
  const encoded = encodeURIComponent(slug);
  switch (platform) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encoded}`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encoded}?mode=json&limit=1`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encoded}`;
    default:
      // No adapter, so no probe. Guessing at a URL for a platform this app
      // cannot read afterwards would be a hit that leads nowhere.
      return null;
  }
}

/**
 * Greenhouse's board endpoint returns `{"name":"Esri","content":""}`. The name
 * is the company's own, which is worth having: the board form describes company
 * name as "yours to author", and pre-filling it from the source beats retyping.
 */
function greenhouseName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const name = (payload as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

export class AtsProber {
  readonly #http: PoliteFetcher;

  constructor(http: PoliteFetcher) {
    this.#http = http;
  }

  async probe(platform: Platform, slug: string): Promise<ProbeResult> {
    const url = probeUrl(platform, slug);
    // Not "no board here" — we never asked, and saying otherwise would be
    // inventing an answer.
    if (url === null) return { found: false, error: `No adapter for ${platform} yet.` };

    try {
      const payload = await this.#http.fetchJson<unknown>(url);
      return platform === "greenhouse"
        ? { found: true, ...maybeName(greenhouseName(payload)) }
        : { found: true };
    } catch (error) {
      // A 404 is the platform answering the question, clearly and correctly.
      if (error instanceof FetchFailure && error.kind === "not_found") {
        return { found: false };
      }
      // Everything else is a failure to find out. Saying "no board here" would
      // be inventing an answer out of a timeout.
      return {
        found: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function maybeName(name: string | undefined): { companyName?: string } {
  return name === undefined ? {} : { companyName: name };
}
