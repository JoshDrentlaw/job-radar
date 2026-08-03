import { assert, assertEquals, assertRejects } from "@std/assert";
import { AnthropicLlmClient } from "@adapters/llm/anthropic.ts";
import { LlmError, LlmRefusalError, LlmTruncatedError } from "@domain/llm.ts";

interface SentBody {
  model: string;
  max_tokens: number;
  system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  messages: Array<{ role: string; content: string }>;
  output_config?: { format?: { type: string; schema: Record<string, unknown> } };
}

/** Captures the request body and replies with a canned Messages API response. */
function fakeApi(reply: Record<string, unknown>, status = 200) {
  const sent: SentBody[] = [];
  const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: impl as unknown as typeof fetch, sent };
}

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  };
}

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };

function clientWith(reply: Record<string, unknown>, status = 200) {
  const api = fakeApi(reply, status);
  return {
    api,
    client: new AnthropicLlmClient({
      apiKey: "test-key",
      model: "claude-opus-5",
      fetchImpl: api.fetch,
    }),
  };
}

Deno.test("the cache breakpoint sits on the stable corpus, never on the volatile part", async () => {
  const { api, client } = clientWith(message({}));
  await client.complete({
    system: "rules",
    cacheablePrefix: "the fact corpus",
    messages: [{ role: "user", content: "the posting, different every call" }],
    schema: SCHEMA,
  });

  const body = api.sent[0]!;
  // Rules first, corpus second — and the breakpoint on the corpus, so the
  // prefix through it is reusable while the posting stays outside it.
  assertEquals(body.system.length, 2);
  assertEquals(body.system[0]!.text, "rules");
  assertEquals(body.system[0]!.cache_control, undefined);
  assertEquals(body.system[1]!.text, "the fact corpus");
  assertEquals(body.system[1]!.cache_control, { type: "ephemeral" });
  assertEquals(body.messages[0]!.content, "the posting, different every call");
});

Deno.test("no cacheable prefix means no breakpoint at all", async () => {
  const { api, client } = clientWith(message({}));
  await client.complete({ system: "rules", messages: [], schema: SCHEMA });
  assertEquals(api.sent[0]!.system.length, 1);
  assertEquals(api.sent[0]!.system[0]!.cache_control, undefined);
});

Deno.test("the caller's schema is sent as a structured-output constraint", async () => {
  const { api, client } = clientWith(message({}));
  await client.complete({ system: "s", messages: [], schema: SCHEMA });
  assertEquals(api.sent[0]!.output_config?.format?.type, "json_schema");
  assertEquals(api.sent[0]!.output_config?.format?.schema, SCHEMA);
  assertEquals(api.sent[0]!.model, "claude-opus-5");
});

Deno.test("a successful response is parsed with usage carried through", async () => {
  const { client } = clientWith(message({
    content: [{ type: "text", text: '{"rewrites":[]}' }],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
  }));
  const response = await client.complete({ system: "s", messages: [], schema: SCHEMA });
  assertEquals(response.json, { rewrites: [] });
  assertEquals(response.usage.cacheReadInputTokens, 900);
  assertEquals(response.model, "claude-opus-5");
});

Deno.test("a refusal raises instead of being read as an answer", async () => {
  const { client } = clientWith(message({
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "no" },
    content: [],
  }));
  const error = await client.complete({ system: "s", messages: [], schema: SCHEMA })
    .catch((e: unknown) => e);
  assert(error instanceof LlmRefusalError);
  assertEquals(error.category, "cyber");
});

Deno.test("a truncated response raises — half a proposal is not a proposal", async () => {
  const { client } = clientWith(message({
    stop_reason: "max_tokens",
    content: [{ type: "text", text: '{"rewrites":[{"factId":"f-1"' }],
  }));
  await assertRejects(
    () => client.complete({ system: "s", messages: [], schema: SCHEMA }),
    LlmTruncatedError,
  );
});

Deno.test("non-JSON text is rejected rather than guessed at", async () => {
  const { client } = clientWith(message({ content: [{ type: "text", text: "I'm sorry, but…" }] }));
  await assertRejects(
    () => client.complete({ system: "s", messages: [], schema: SCHEMA }),
    LlmError,
    "not valid JSON",
  );
});

Deno.test("an empty response is an error, not an empty result", async () => {
  const { client } = clientWith(message({ content: [] }));
  await assertRejects(
    () => client.complete({ system: "s", messages: [], schema: SCHEMA }),
    LlmError,
  );
});

Deno.test("a rejected API key produces an actionable message", async () => {
  const { client } = clientWith(
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    401,
  );
  await assertRejects(
    () => client.complete({ system: "s", messages: [], schema: SCHEMA }),
    LlmError,
    "ANTHROPIC_API_KEY",
  );
});

Deno.test("an unknown model points at the model setting", async () => {
  const { client } = clientWith(
    { type: "error", error: { type: "not_found_error", message: "model not found" } },
    404,
  );
  await assertRejects(
    () => client.complete({ system: "s", messages: [], schema: SCHEMA }),
    LlmError,
    "ANTHROPIC_MODEL",
  );
});
