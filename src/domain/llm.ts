/**
 * The LLM port (§4).
 *
 * The domain states what it wants — a system prompt, a stable prefix worth
 * caching, and a JSON Schema the answer must satisfy — and knows nothing about
 * Anthropic, HTTP, or SDK types. Everything that enforces the fabrication
 * constraint (§8) lives in the domain on top of this, so it is testable with a
 * fake and never touches the network.
 */

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  /**
   * Stable across many calls — the resume corpus (§3). The adapter marks a
   * cache breakpoint here; anything volatile must go in `messages` instead, or
   * the prefix changes and the cache never reads.
   */
  readonly cacheablePrefix?: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  /** The response must satisfy this schema, structurally. */
  readonly schema: Record<string, unknown>;
  readonly maxTokens?: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface LlmResponse {
  /** Parsed JSON, shaped by the request's schema. Validated by the caller. */
  readonly json: unknown;
  readonly model: string;
  readonly usage: LlmUsage;
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** The model declined the request. Not a bug — surface it, do not retry blindly. */
export class LlmRefusalError extends Error {
  override readonly name = "LlmRefusalError";
  readonly category: string | null;
  constructor(message: string, category: string | null) {
    super(message);
    this.category = category;
  }
}

/** The response was cut off mid-answer; a truncated JSON body is not a result. */
export class LlmTruncatedError extends Error {
  override readonly name = "LlmTruncatedError";
}

/** Transport, auth, or malformed-response failures. */
export class LlmError extends Error {
  override readonly name = "LlmError";
}
