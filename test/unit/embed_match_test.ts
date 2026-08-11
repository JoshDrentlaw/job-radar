import { assert, assertEquals } from "@std/assert";
import type { FacetId, PostingId } from "@platform/ids.ts";
import { FixedClock } from "@platform/clock.ts";
import { nullLogger } from "@platform/logger.ts";
import {
  type ChunkRepo,
  type EmbeddedChunk,
  type Embedder,
  facetContentHash,
  type FacetRepo,
  type MatchRepo,
  type PostingChunkScore,
  type ProfileFacet,
  type StalePair,
  type StalePosting,
} from "@domain/discovery/matching.ts";
import { embedPending } from "@domain/discovery/embed.ts";
import { scorePending } from "@domain/discovery/match.ts";

/** Deterministic "embedding": character-class frequencies, L2-normalized. */
class FakeEmbedder implements Embedder {
  readonly model: string;
  calls = 0;
  embedded: string[] = [];

  constructor(model = "fake-1") {
    this.model = model;
  }

  embed(texts: readonly string[], _kind: "document" | "query"): Promise<number[][]> {
    this.calls += 1;
    this.embedded.push(...texts);
    return Promise.resolve(texts.map((text) => {
      const vector = new Array<number>(26).fill(0);
      for (const ch of text.toLowerCase()) {
        const code = ch.charCodeAt(0) - 97;
        if (code >= 0 && code < 26) vector[code]! += 1;
      }
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    }));
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // inputs are unit vectors
}

interface StoredChunk extends EmbeddedChunk {
  readonly model: string;
  readonly chunkerVersion: string;
  readonly contentHash: string;
  bestScore: number | null;
}

/** Shared in-memory state standing in for the discovery schema. */
class Store {
  facets = new Map<FacetId, ProfileFacet>();
  postings = new Map<PostingId, { title: string; description: string; contentHash: string }>();
  postingChunks = new Map<PostingId, StoredChunk[]>();
  facetChunks = new Map<FacetId, StoredChunk[]>();
  matches = new Map<string, {
    score: number;
    model: string;
    postingContentHash: string;
    facetContentHash: string;
    matchedChunkSeq: number;
  }>();
}

class FakeFacetRepo implements Pick<FacetRepo, "staleForModel"> {
  constructor(readonly store: Store) {}

  staleForModel(model: string, chunkerVersion: string): Promise<ProfileFacet[]> {
    const stale = [...this.store.facets.values()].filter((facet) => {
      if (!facet.active) return false;
      const chunks = this.store.facetChunks.get(facet.id) ?? [];
      return !chunks.some((c) =>
        c.model === model && c.chunkerVersion === chunkerVersion &&
        c.contentHash === facet.contentHash
      );
    });
    return Promise.resolve(stale);
  }
}

class FakeChunkRepo implements ChunkRepo {
  constructor(readonly store: Store) {}

  #stale(model: string, chunkerVersion: string): PostingId[] {
    return [...this.store.postings.entries()]
      .filter(([id, posting]) => {
        const chunks = this.store.postingChunks.get(id) ?? [];
        return !chunks.some((c) =>
          c.model === model && c.chunkerVersion === chunkerVersion &&
          c.contentHash === posting.contentHash
        );
      })
      .map(([id]) => id);
  }

  stalePostings(model: string, chunkerVersion: string, limit: number): Promise<StalePosting[]> {
    return Promise.resolve(
      this.#stale(model, chunkerVersion).slice(0, limit).map((id) => {
        const p = this.store.postings.get(id)!;
        return { id, title: p.title, descriptionText: p.description, contentHash: p.contentHash };
      }),
    );
  }

  stalePostingCount(model: string, chunkerVersion: string): Promise<number> {
    return Promise.resolve(this.#stale(model, chunkerVersion).length);
  }

  replacePostingChunks(
    postingId: PostingId,
    model: string,
    chunkerVersion: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
  ): Promise<void> {
    this.store.postingChunks.set(
      postingId,
      chunks.map((c) => ({ ...c, model, chunkerVersion, contentHash, bestScore: null })),
    );
    return Promise.resolve();
  }

  replaceFacetChunks(
    facetId: FacetId,
    model: string,
    chunkerVersion: string,
    contentHash: string,
    chunks: readonly EmbeddedChunk[],
  ): Promise<void> {
    this.store.facetChunks.set(
      facetId,
      chunks.map((c) => ({ ...c, model, chunkerVersion, contentHash, bestScore: null })),
    );
    return Promise.resolve();
  }

  postingChunkScores(postingId: PostingId): Promise<PostingChunkScore[]> {
    const chunks = this.store.postingChunks.get(postingId) ?? [];
    return Promise.resolve(chunks.map((c) => ({
      seq: c.seq,
      text: c.text,
      bestScore: c.bestScore,
    })));
  }

  facetEmbedStatus(): Promise<Map<FacetId, { chunks: number; embeddedAt: Date }>> {
    return Promise.resolve(new Map());
  }
}

class FakeMatchRepo implements Pick<MatchRepo, "stalePairs" | "scorePair" | "refreshBestScores"> {
  constructor(readonly store: Store) {}

  stalePairs(model: string): Promise<StalePair[]> {
    const pairs: StalePair[] = [];
    for (const [postingId, posting] of this.store.postings) {
      const postingChunks = (this.store.postingChunks.get(postingId) ?? []).filter(
        (c) => c.model === model && c.contentHash === posting.contentHash,
      );
      if (postingChunks.length === 0) continue;
      for (const [facetId, facet] of this.store.facets) {
        if (!facet.active) continue;
        const facetChunks = (this.store.facetChunks.get(facetId) ?? []).filter(
          (c) => c.model === model && c.contentHash === facet.contentHash,
        );
        if (facetChunks.length === 0) continue;
        const existing = this.store.matches.get(`${postingId}|${facetId}`);
        if (
          existing !== undefined && existing.model === model &&
          existing.postingContentHash === posting.contentHash &&
          existing.facetContentHash === facet.contentHash
        ) continue;
        pairs.push({
          postingId,
          facetId,
          postingContentHash: posting.contentHash,
          facetContentHash: facet.contentHash,
        });
      }
    }
    return Promise.resolve(pairs);
  }

  scorePair(pair: StalePair, model: string): Promise<number | null> {
    const postingChunks = (this.store.postingChunks.get(pair.postingId) ?? []).filter(
      (c) => c.model === model && c.contentHash === pair.postingContentHash,
    );
    const facetChunks = (this.store.facetChunks.get(pair.facetId) ?? []).filter(
      (c) => c.model === model && c.contentHash === pair.facetContentHash,
    );
    if (postingChunks.length === 0 || facetChunks.length === 0) return Promise.resolve(null);

    let best = -Infinity;
    let bestSeq = -1;
    for (const pc of postingChunks) {
      for (const fc of facetChunks) {
        const score = cosine(pc.embedding, fc.embedding);
        if (score > best) {
          best = score;
          bestSeq = pc.seq;
        }
      }
    }
    this.store.matches.set(`${pair.postingId}|${pair.facetId}`, {
      score: best,
      model,
      postingContentHash: pair.postingContentHash,
      facetContentHash: pair.facetContentHash,
      matchedChunkSeq: bestSeq,
    });
    return Promise.resolve(best);
  }

  refreshBestScores(postingIds: readonly PostingId[], model: string): Promise<void> {
    for (const postingId of postingIds) {
      for (const chunk of this.store.postingChunks.get(postingId) ?? []) {
        let best: number | null = null;
        for (const [facetId, facet] of this.store.facets) {
          if (!facet.active) continue;
          for (const fc of this.store.facetChunks.get(facetId) ?? []) {
            if (fc.model !== model || fc.contentHash !== facet.contentHash) continue;
            const score = cosine(chunk.embedding, fc.embedding);
            if (best === null || score > best) best = score;
          }
        }
        chunk.bestScore = best;
      }
    }
    return Promise.resolve();
  }
}

async function facet(store: Store, id: string, name: string, content: string): Promise<void> {
  store.facets.set(id as FacetId, {
    id: id as FacetId,
    name,
    content,
    active: true,
    contentHash: await facetContentHash(content),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

function posting(store: Store, id: string, title: string, description: string): void {
  store.postings.set(id as PostingId, { title, description, contentHash: `hash(${description})` });
}

function harness(store: Store, embedder: FakeEmbedder) {
  const clock = new FixedClock("2026-08-03T12:00:00Z");
  const facets = new FakeFacetRepo(store) as unknown as FacetRepo;
  const chunks = new FakeChunkRepo(store);
  const matches = new FakeMatchRepo(store) as unknown as MatchRepo;
  return {
    embed: () => embedPending({ facets, chunks, embedder, clock, logger: nullLogger }),
    embedLimited: (postingLimit: number) =>
      embedPending({ facets, chunks, embedder, clock, logger: nullLogger }, { postingLimit }),
    score: () => scorePending({ matches, model: embedder.model, clock, logger: nullLogger }),
  };
}

Deno.test("embed: embeds stale facets and postings, then goes quiet", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript deno postgres services");
  posting(store, "greenhouse:acme:1", "Backend Engineer", "typescript deno postgres apis");
  posting(store, "greenhouse:acme:2", "Baker", "sourdough croissants ovens");

  const h = harness(store, embedder);
  const first = await h.embed();
  assertEquals(first.facetsEmbedded, 1);
  assertEquals(first.postingsEmbedded, 2);
  assertEquals(first.postingsRemaining, 0);
  assert(first.chunksEmbedded >= 3);

  // The gate: nothing changed, so nothing re-embeds (§7).
  const second = await h.embed();
  assertEquals(second.facetsEmbedded, 0);
  assertEquals(second.postingsEmbedded, 0);
  assertEquals(second.chunksEmbedded, 0);
});

Deno.test("embed: a facet chunked under an older chunker version re-embeds even though its content did not change", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript deno postgres services");
  posting(store, "p:a:1", "Backend Engineer", "typescript deno postgres apis");

  // Simulate a facet already embedded before the chunker fix: fresh model
  // and content hash, but recorded at chunker version "1". CHUNKER_VERSION
  // (imported by embed.ts, not injected here) is "2".
  const oldFacet = store.facets.get("f1" as FacetId)!;
  store.facetChunks.set("f1" as FacetId, [{
    seq: 0,
    text: oldFacet.content,
    embedding: [1],
    model: embedder.model,
    chunkerVersion: "1",
    contentHash: oldFacet.contentHash,
    bestScore: null,
  }]);

  const h = harness(store, embedder);
  const report = await h.embed();
  assertEquals(report.facetsEmbedded, 1, "the version mismatch alone should mark it stale");

  const stored = store.facetChunks.get("f1" as FacetId)!;
  assert(stored.every((c) => c.chunkerVersion !== "1"), "re-embedding writes the current version");
});

Deno.test("embed: a changed posting hash re-embeds only that posting", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript deno");
  posting(store, "p:a:1", "Engineer", "typescript everywhere");
  posting(store, "p:a:2", "Engineer II", "deno everywhere");

  const h = harness(store, embedder);
  await h.embed();

  posting(store, "p:a:1", "Engineer", "now with rust"); // new content hash
  const report = await h.embed();
  assertEquals(report.postingsEmbedded, 1);
  assertEquals(report.facetsEmbedded, 0);
});

Deno.test("embed: the posting limit bounds a run and reports the remainder", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript");
  for (let i = 0; i < 5; i++) posting(store, `p:a:${i}`, `Role ${i}`, `description ${i}`);

  const h = harness(store, embedder);
  const first = await h.embedLimited(2);
  assertEquals(first.postingsEmbedded, 2);
  assertEquals(first.postingsRemaining, 3);

  const second = await h.embedLimited(2);
  assertEquals(second.postingsEmbedded, 2);
  assertEquals(second.postingsRemaining, 1);
});

Deno.test("embed: posting chunks store verbatim text, embed input carries the title", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  posting(store, "p:a:1", "Platform Engineer", "kubernetes and postgres");

  const h = harness(store, embedder);
  await h.embed();

  const stored = store.postingChunks.get("p:a:1" as PostingId)!;
  assertEquals(stored[0]!.text, "kubernetes and postgres");
  assert(embedder.embedded.some((t) => t.startsWith("Platform Engineer\n\n")));
});

Deno.test("match: scores stale pairs once and ranks the on-topic posting higher", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript deno postgres backend services");
  posting(store, "p:a:1", "Backend Engineer", "typescript deno postgres backend services");
  posting(store, "p:a:2", "Baker", "sourdough croissants butter ovens pastry");

  const h = harness(store, embedder);
  await h.embed();

  const first = await h.score();
  assertEquals(first.pairsConsidered, 2);
  assertEquals(first.pairsScored, 2);
  assertEquals(first.postingsTouched, 2);

  const onTopic = store.matches.get("p:a:1|f1")!.score;
  const offTopic = store.matches.get("p:a:2|f1")!.score;
  assert(onTopic > offTopic, `expected ${onTopic} > ${offTopic}`);

  // Idempotent until something changes.
  const second = await h.score();
  assertEquals(second.pairsConsidered, 0);
  assertEquals(second.pairsScored, 0);
});

Deno.test("match: an edited facet rescoring refreshes chunk best-scores", async () => {
  const store = new Store();
  const embedder = new FakeEmbedder();
  await facet(store, "f1", "backend", "typescript deno");
  posting(store, "p:a:1", "Engineer", "typescript deno");

  const h = harness(store, embedder);
  await h.embed();
  await h.score();

  const chunk = store.postingChunks.get("p:a:1" as PostingId)![0]!;
  assert(chunk.bestScore !== null);

  await facet(store, "f1", "backend", "entirely different profile text now");
  await h.embed(); // re-embeds the facet
  const report = await h.score(); // pair is stale again
  assertEquals(report.pairsScored, 1);
});

Deno.test("match: pairs whose vectors are missing are reported unready", async () => {
  // stalePairs said the pair was ready, but by scorePair time the vectors are
  // gone (a concurrent re-embed): the run reports it rather than failing.
  const pair: StalePair = {
    postingId: "p:a:1" as PostingId,
    facetId: "f1" as FacetId,
    postingContentHash: "h1",
    facetContentHash: "h2",
  };
  const stub = {
    stalePairs: () => Promise.resolve([pair]),
    scorePair: () => Promise.resolve(null),
    refreshBestScores: () => Promise.reject(new Error("must not refresh with nothing scored")),
  } as unknown as MatchRepo;

  const report = await scorePending({
    matches: stub,
    model: "fake-1",
    clock: new FixedClock("2026-08-03T12:00:00Z"),
    logger: nullLogger,
  });
  assertEquals(report.pairsConsidered, 1);
  assertEquals(report.pairsUnready, 1);
  assertEquals(report.pairsScored, 0);
  assertEquals(report.postingsTouched, 0);
});
