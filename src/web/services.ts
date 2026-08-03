/**
 * The composition root's dependency bundle.
 *
 * Handlers receive this off the request context. Everything in it is an
 * interface from the domain or the auth layer, so a handler never names a
 * concrete adapter and tests can substitute fakes wholesale.
 */

import type { Clock } from "@platform/clock.ts";
import type { Logger } from "@platform/logger.ts";
import type { Platform } from "@platform/ids.ts";
import type {
  BoardRegistry,
  BoardSource,
  PostingRepo,
  SnapshotRepo,
} from "@domain/discovery/types.ts";
import type {
  ChunkRepo,
  Embedder,
  FacetRepo,
  MatchRepo,
  SettingsRepo,
} from "@domain/discovery/matching.ts";
import type { CollectionRunRepo } from "@domain/discovery/coverage.ts";
import type { FactRepo, VariantRepo } from "@domain/dossier/types.ts";
import type { DocumentRepo, TailoringRepo } from "@domain/dossier/proposals.ts";
import type { LlmClient } from "@domain/llm.ts";
import type { ApplicationRepo } from "@domain/pipeline/types.ts";
import type { ApiTokenService } from "@auth/api-token.ts";
import type { PasskeyService } from "@auth/webauthn/service.ts";
import type { SessionService } from "@auth/session.ts";
import type { LoginRateLimiter } from "@auth/rate-limit.ts";
import type { UserRepo } from "@auth/types.ts";

export interface Services {
  readonly boards: BoardRegistry;
  readonly postings: PostingRepo;
  readonly snapshots: SnapshotRepo;
  readonly runs: CollectionRunRepo;
  readonly users: UserRepo;
  readonly sessions: SessionService;
  readonly rateLimiter: LoginRateLimiter;
  readonly sourceFor: (platform: Platform) => BoardSource | null;
  readonly facets: FacetRepo;
  readonly chunks: ChunkRepo;
  readonly matches: MatchRepo;
  readonly settings: SettingsRepo;
  /** Null when no embedding API key is configured; match views say so. */
  readonly embedder: Embedder | null;
  readonly facts: FactRepo;
  readonly variants: VariantRepo;
  readonly tailoring: TailoringRepo;
  readonly documents: DocumentRepo;
  /** Null when no Anthropic API key is configured; the dossier pages say so. */
  readonly llm: LlmClient | null;
  readonly applications: ApplicationRepo;
  readonly apiTokens: ApiTokenService;
  readonly passkeys: PasskeyService;
  readonly clock: Clock;
  readonly logger: Logger;
}
