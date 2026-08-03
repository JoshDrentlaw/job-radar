import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { EmbeddingError, parseEmbeddings, VoyageEmbedder } from "@adapters/embedding/voyage.ts";

function responseWith(embeddings: number[][], shuffle = false): unknown {
  const data = embeddings.map((embedding, index) => ({ embedding, index }));
  if (shuffle) data.reverse();
  return { object: "list", data, model: "voyage-3.5" };
}

Deno.test("parseEmbeddings: restores order from the index field", () => {
  const parsed = parseEmbeddings(responseWith([[1, 0], [0, 1]], true), 2);
  assertEquals(parsed, [[1, 0], [0, 1]]);
});

Deno.test("parseEmbeddings: rejects count mismatch and malformed entries", () => {
  assertThrows(() => parseEmbeddings(responseWith([[1, 0]]), 2), EmbeddingError);
  assertThrows(() => parseEmbeddings({ data: [{ embedding: [1], index: 5 }] }, 1), EmbeddingError);
  assertThrows(() => parseEmbeddings({ data: [{ embedding: [], index: 0 }] }, 1), EmbeddingError);
  assertThrows(
    () => parseEmbeddings({ data: [{ embedding: [NaN], index: 0 }] }, 1),
    EmbeddingError,
  );
  assertThrows(() => parseEmbeddings("nonsense", 1), EmbeddingError);
});

function fakeFetch(
  handler: (body: { input: string[]; model: string; input_type: string }) => Response,
): { fetch: typeof fetch; calls: Array<{ input: string[]; input_type: string }> } {
  const calls: Array<{ input: string[]; input_type: string }> = [];
  const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    calls.push({ input: body.input, input_type: body.input_type });
    return Promise.resolve(handler(body));
  };
  return { fetch: impl as typeof fetch, calls };
}

const noSleep = () => Promise.resolve();

Deno.test("voyage: sends model and input_type, returns vectors in order", async () => {
  const { fetch, calls } = fakeFetch((body) => {
    assertEquals(body.model, "voyage-3.5");
    return Response.json(responseWith(body.input.map((_, i) => [i, 1])));
  });
  const embedder = new VoyageEmbedder({
    apiKey: "k",
    model: "voyage-3.5",
    fetchImpl: fetch,
    sleep: noSleep,
  });

  const vectors = await embedder.embed(["a", "b", "c"], "document");
  assertEquals(vectors, [[0, 1], [1, 1], [2, 1]]);
  assertEquals(calls[0]!.input_type, "document");
});

Deno.test("voyage: splits requests above the batch cap and concatenates", async () => {
  const { fetch, calls } = fakeFetch((body) =>
    Response.json(responseWith(body.input.map(() => [1])))
  );
  const embedder = new VoyageEmbedder({
    apiKey: "k",
    model: "m",
    fetchImpl: fetch,
    sleep: noSleep,
  });

  const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const vectors = await embedder.embed(texts, "query");
  assertEquals(vectors.length, 150);
  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.input.length, 128);
  assertEquals(calls[1]!.input.length, 22);
  assert(calls.every((c) => c.input_type === "query"));
});

Deno.test("voyage: retries retryable statuses, then succeeds", async () => {
  let attempt = 0;
  const { fetch } = fakeFetch((body) => {
    attempt += 1;
    if (attempt < 3) return new Response("busy", { status: 429 });
    return Response.json(responseWith(body.input.map(() => [2])));
  });
  const embedder = new VoyageEmbedder({
    apiKey: "k",
    model: "m",
    fetchImpl: fetch,
    sleep: noSleep,
  });

  assertEquals(await embedder.embed(["x"], "document"), [[2]]);
  assertEquals(attempt, 3);
});

Deno.test("voyage: a non-retryable status fails immediately", async () => {
  let attempts = 0;
  const { fetch } = fakeFetch(() => {
    attempts += 1;
    return new Response("bad key", { status: 401 });
  });
  const embedder = new VoyageEmbedder({
    apiKey: "k",
    model: "m",
    fetchImpl: fetch,
    sleep: noSleep,
  });

  await assertRejects(() => embedder.embed(["x"], "document"), EmbeddingError, "401");
  assertEquals(attempts, 1);
});

Deno.test("voyage: empty input never calls the API", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(responseWith([])));
  const embedder = new VoyageEmbedder({
    apiKey: "k",
    model: "m",
    fetchImpl: fetch,
    sleep: noSleep,
  });
  assertEquals(await embedder.embed([], "document"), []);
  assertEquals(calls.length, 0);
});
