/**
 * The embedding drain (§7).
 *
 * Embedding is the only expensive operation, so it is gated hard: a posting is
 * embedded only when no vectors exist for its current content hash under the
 * current model, and likewise for facets. Everything already embedded is not
 * touched — running this twice in a row does nothing the second time.
 */

import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import { chunkText } from "./chunk.ts";
import type { ChunkRepo, EmbeddedChunk, Embedder, FacetRepo } from "./matching.ts";

export interface EmbedDeps {
  readonly facets: FacetRepo;
  readonly chunks: ChunkRepo;
  readonly embedder: Embedder;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface EmbedReport {
  readonly facetsEmbedded: number;
  readonly postingsEmbedded: number;
  readonly chunksEmbedded: number;
  /** Postings still waiting after the per-run limit. */
  readonly postingsRemaining: number;
}

/**
 * Per-run posting cap. One manual click embeds this many postings at most;
 * clicking again continues where it left off. Keeps a first run over a large
 * backlog from turning one request into thousands of API calls.
 */
export const DEFAULT_POSTING_LIMIT = 200;

export async function embedPending(
  deps: EmbedDeps,
  opts: { postingLimit?: number } = {},
): Promise<EmbedReport> {
  const { embedder, logger } = deps;
  const model = embedder.model;
  let chunksEmbedded = 0;

  // Facets first: they are few, and fresh facet vectors are what posting
  // scores are computed against.
  const staleFacets = await deps.facets.staleForModel(model);
  for (const facet of staleFacets) {
    const chunks = chunkText(facet.content);
    if (chunks.length === 0) {
      logger.warn("facet has no embeddable content", { facet: facet.name });
      continue;
    }
    const vectors = await embedder.embed(chunks.map((c) => c.text), "query");
    const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      seq: chunk.seq,
      text: chunk.text,
      embedding: vectors[i]!,
    }));
    await deps.chunks.replaceFacetChunks(
      facet.id,
      model,
      facet.contentHash,
      embedded,
      deps.clock.now(),
    );
    chunksEmbedded += embedded.length;
    logger.info("facet embedded", { facet: facet.name, chunks: embedded.length, model });
  }

  const limit = opts.postingLimit ?? DEFAULT_POSTING_LIMIT;
  const stalePostings = await deps.chunks.stalePostings(model, limit);
  let postingsEmbedded = 0;

  for (const posting of stalePostings) {
    const chunks = chunkText(posting.descriptionText);
    if (chunks.length === 0) {
      logger.warn("posting has no embeddable description", { postingId: posting.id });
      continue;
    }
    // The stored chunk text stays verbatim — it is what a match quotes — but
    // the embedded input is prefixed with the title so every chunk's vector
    // carries what role the passage belongs to.
    const inputs = chunks.map((c) => `${posting.title}\n\n${c.text}`);
    const vectors = await embedder.embed(inputs, "document");
    const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      seq: chunk.seq,
      text: chunk.text,
      embedding: vectors[i]!,
    }));
    await deps.chunks.replacePostingChunks(
      posting.id,
      model,
      posting.contentHash,
      embedded,
      deps.clock.now(),
    );
    chunksEmbedded += embedded.length;
    postingsEmbedded += 1;
  }

  const postingsRemaining = await deps.chunks.stalePostingCount(model);
  const report: EmbedReport = {
    facetsEmbedded: staleFacets.length,
    postingsEmbedded,
    chunksEmbedded,
    postingsRemaining,
  };
  logger.info("embed drain finished", { ...report, model });
  return report;
}
