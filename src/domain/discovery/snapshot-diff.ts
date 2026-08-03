/**
 * Snapshot diffing (§6).
 *
 * Each fetch produces a full snapshot. Diffing against the previous one yields
 * appeared / changed / disappeared. There is no incremental delta tracking to go
 * wrong, and a missed run costs nothing beyond a coarser diff.
 *
 * "Disappeared" means no longer listed. It does not mean filled, cancelled or
 * closed, and nothing downstream may treat it as though it did.
 */

import type { SnapshotDiff, SnapshotEntry } from "./types.ts";

export function diffSnapshots(
  previous: readonly SnapshotEntry[] | null,
  current: readonly SnapshotEntry[],
): SnapshotDiff {
  const currentById = new Map(current.map((e) => [e.externalId, e.contentHash]));

  // A board with no prior successful snapshot: everything is new. Not "changed",
  // and nothing can have disappeared, because there was no previous listing to
  // disappear from.
  if (previous === null) {
    return {
      appeared: [...currentById.keys()],
      changed: [],
      disappeared: [],
      unchanged: [],
    };
  }

  const previousById = new Map(previous.map((e) => [e.externalId, e.contentHash]));

  const appeared: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [externalId, hash] of currentById) {
    const previousHash = previousById.get(externalId);
    if (previousHash === undefined) appeared.push(externalId);
    else if (previousHash !== hash) changed.push(externalId);
    else unchanged.push(externalId);
  }

  const disappeared: string[] = [];
  for (const externalId of previousById.keys()) {
    if (!currentById.has(externalId)) disappeared.push(externalId);
  }

  return { appeared, changed, disappeared, unchanged };
}
