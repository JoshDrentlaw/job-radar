/**
 * Anthropic adapter for the LlmClient port.
 *
 * Three things this does that matter:
 *
 * 1. **Structured outputs.** `output_config.format` constrains the response to
 *    the caller's JSON Schema, so §8 rule 2 ("must return this shape and
 *    nothing else") is enforced by the API rather than by asking politely.
 * 2. **Prompt caching on the fact corpus (§3).** The corpus is stable across
 *    many calls, so it goes in a system block with a cache breakpoint; the
 *    posting — different every call — goes in `messages`, after the breakpoint.
 *    Caching is a prefix match, so that ordering is the whole trick.
 * 3. **Honest stop_reason handling.** A refusal and a truncation are both
 *    HTTP 200 with unusable content; both raise here rather than being parsed
 *    as if they were answers.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "@domain/llm.ts";
import { LlmError, LlmRefusalError, LlmTruncatedError } from "@domain/llm.ts";

/**
 * Adaptive thinking is on by default on this model and counts against
 * max_tokens, so the budget covers reasoning plus the JSON body. Tailoring a
 * few dozen facts needs far less than this; the headroom is what keeps a long
 * fact set from truncating mid-answer.
 */
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicOptions {
  readonly apiKey: string;
  /** Recorded on every run so a proposal's provenance is inspectable. */
  readonly model: string;
  readonly maxTokens?: number;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #maxTokens: number;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      // The SDK already retries 408/409/429/5xx with backoff; one extra
      // attempt suits a single-user app that would rather wait than fail.
      maxRetries: 3,
      ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Order is load-bearing: rules, then the cacheable corpus carrying the
    // breakpoint. Anything volatile must come after it, in messages.
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: request.system }];
    if (request.cacheablePrefix !== undefined) {
      system.push({
        type: "text",
        text: request.cacheablePrefix,
        cache_control: { type: "ephemeral" },
      });
    }

    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? this.#maxTokens,
        system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { format: { type: "json_schema", schema: request.schema } },
      });
    } catch (error) {
      throw asLlmError(error);
    }

    // Check why generation stopped before trusting anything in `content`.
    if (message.stop_reason === "refusal") {
      throw new LlmRefusalError(
        "The model declined this request. Nothing was generated.",
        message.stop_details?.category ?? null,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmTruncatedError(
        "The response hit the token limit and is incomplete. Raise the limit or " +
          "reduce the fact set; a truncated proposal is not a proposal.",
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim() === "") {
      throw new LlmError(`The model returned no text (stop_reason: ${message.stop_reason}).`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Structured outputs make this near-impossible; if it happens the
      // response is not what the schema promised and must not be guessed at.
      throw new LlmError("The model's response was not valid JSON.");
    }

    return { json, model: message.model, usage: toUsage(message.usage) };
  }
}

function toUsage(usage: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Typed SDK errors, most specific first. The messages are user-facing: this is
 * a single-user app and the person reading them is the operator.
 */
function asLlmError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("This API key is not permitted to use the configured model.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new LlmError("The configured model does not exist. Check ANTHROPIC_MODEL.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError("Rate limited by the Anthropic API, after retries. Try again shortly.");
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new LlmError(`The Anthropic API rejected the request: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    // Subclass of APIError — must be checked before it.
    return new LlmError("Could not reach the Anthropic API. Check network and proxy settings.");
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError(`Anthropic API error (${error.status ?? "unknown"}): ${error.message}`);
  }
  return error instanceof Error ? error : new LlmError(String(error));
}
