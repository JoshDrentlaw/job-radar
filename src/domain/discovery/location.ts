/**
 * Location normalization and the remote-hint guess (§5, §16 q3).
 *
 * This module is deliberately reluctant. Location strings in real feeds look
 * like this (sampled from three live Greenhouse boards):
 *
 *   'San Francisco, CA • New York, NY • United States'
 *   'San Francisco, CA | New York City, NY | Seattle, WA'
 *   'Hybrid - San Francisco, New York City, Austin'
 *   'Remote-Friendly (Travel-Required) | San Francisco, CA | Washington, DC'
 *   'London, UK; Ontario, CAN; Remote-Friendly, United States; San Francisco, CA'
 *
 * Three different separators, modality prefixes mixed into the place list, and
 * "remote-friendly" co-listed with named offices.
 *
 * The rule adopted here: assert a modality only when the string says one, and
 * say `unknown` otherwise. In particular a bare city name does NOT become
 * `onsite` — a fully remote company listing a hub city is indistinguishable from
 * an in-office role at this layer, and guessing would put a confident wrong
 * label on a large fraction of postings. The raw string is always preserved and
 * always displayed; this is a filter aid, not a fact.
 */

import type { RemoteHint } from "./types.ts";

/**
 * Bumped whenever the rules below change, and recorded on every derived row so
 * stale guesses can be found and recomputed.
 */
export const DERIVATION_VERSION = "location/1";

/** Feeds use bullets, pipes, semicolons and slashes interchangeably. */
const SEPARATOR_PATTERN = /\s*[•|;]\s*|\s+\/\s+/g;

/** Modality words that lead a location string rather than naming a place. */
const MODALITY_PREFIX =
  /^\s*(hybrid|remote(?:[\s-]friendly)?|on[\s-]?site|in[\s-]office)\b\s*(?:\([^)]*\))?\s*[-–—:,]?\s*/i;

const REMOTE_TOKEN = /\bremote\b|\bwork from home\b|\bdistributed\b|\banywhere\b/i;
const REMOTE_FRIENDLY_TOKEN = /\bremote[\s-]friendly\b/i;
const HYBRID_TOKEN = /\bhybrid\b/i;
const ONSITE_TOKEN = /\bon[\s-]?site\b|\bin[\s-]office\b|\bin person\b/i;

export function splitLocations(raw: string): string[] {
  return raw
    .split(SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * A canonical rendering of the places named, with modality prefixes stripped and
 * separators unified. Non-destructive: `locationRaw` is stored untouched and is
 * what the UI shows as the source-asserted value.
 */
export function normalizeLocation(raw: string): string | null {
  const parts = splitLocations(raw)
    .map((part) => part.replace(MODALITY_PREFIX, "").trim())
    .filter((part) => part !== "");

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }

  return unique.length === 0 ? null : unique.join(" | ");
}

/**
 * Derive a modality hint, or admit we do not know.
 *
 * `unknown` is the expected answer for the majority of real postings, and that
 * is the point: it is the difference between "we have no information" and a
 * fabricated `onsite`.
 */
export function deriveRemoteHint(raw: string): RemoteHint {
  const text = raw.trim();
  if (text === "") return "unknown";

  const hybrid = HYBRID_TOKEN.test(text);
  const remote = REMOTE_TOKEN.test(text);
  const onsite = ONSITE_TOKEN.test(text);

  // An explicit hybrid marker is the clearest signal any of these feeds give.
  if (hybrid) return "hybrid";

  if (remote) {
    // "Remote-Friendly | San Francisco, CA | Washington, DC" is genuinely
    // ambiguous — it may mean remote, or a named office, or either. Refuse it.
    const named = splitLocations(text)
      .map((part) => part.replace(MODALITY_PREFIX, "").trim())
      .filter((part) => part !== "" && !REMOTE_TOKEN.test(part));
    const friendlyWithOffices = REMOTE_FRIENDLY_TOKEN.test(text) && named.length > 0;
    if (friendlyWithOffices) return "unknown";
    return onsite ? "unknown" : "remote";
  }

  if (onsite) return "onsite";

  // A bare place name. Says nothing about whether attendance is required.
  return "unknown";
}
