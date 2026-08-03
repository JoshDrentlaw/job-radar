import { assert, assertEquals } from "@std/assert";
import { chunkText, DEFAULT_CHUNK_OPTIONS } from "@domain/discovery/chunk.ts";

const OPTIONS = { targetChars: 200, maxChars: 320 };

function paragraph(label: string, length: number): string {
  const filler = ` ${label}`.repeat(Math.ceil(length / (label.length + 1)));
  return filler.slice(0, length).trim();
}

Deno.test("chunk: empty and whitespace input produce no chunks", () => {
  assertEquals(chunkText(""), []);
  assertEquals(chunkText("   \n\n  "), []);
});

Deno.test("chunk: short text is a single chunk, verbatim", () => {
  const text = "We are hiring a TypeScript engineer.\n\nRemote friendly.";
  const chunks = chunkText(text, OPTIONS);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0], { seq: 0, text });
});

Deno.test("chunk: deterministic — same input, same output", () => {
  const text = Array.from({ length: 12 }, (_, i) => paragraph(`para${i}`, 120)).join("\n\n");
  assertEquals(chunkText(text, OPTIONS), chunkText(text, OPTIONS));
});

Deno.test("chunk: consecutive chunks overlap by a shared paragraph", () => {
  const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(`p${i}`, 90));
  const chunks = chunkText(paragraphs.join("\n\n"), OPTIONS);
  assert(chunks.length >= 2, "expected multiple chunks");
  for (let i = 1; i < chunks.length; i++) {
    const previousTail = chunks[i - 1]!.text.split("\n\n").at(-1)!;
    assert(
      chunks[i]!.text.startsWith(previousTail),
      `chunk ${i} does not start with the previous chunk's closing paragraph`,
    );
  }
});

Deno.test("chunk: every paragraph appears in at least one chunk", () => {
  const paragraphs = Array.from({ length: 10 }, (_, i) => paragraph(`req${i}`, 110));
  const chunks = chunkText(paragraphs.join("\n\n"), OPTIONS);
  for (const p of paragraphs) {
    assert(chunks.some((c) => c.text.includes(p)), `paragraph missing: ${p.slice(0, 20)}`);
  }
});

Deno.test("chunk: a single oversized paragraph is split under the hard cap", () => {
  const long = paragraph("requirementsword", 2_000);
  const chunks = chunkText(long, OPTIONS);
  assert(chunks.length > 1);
  for (const chunk of chunks) {
    assert(chunk.text.length <= OPTIONS.maxChars, `chunk exceeds maxChars: ${chunk.text.length}`);
  }
});

Deno.test("chunk: sequences are contiguous from zero", () => {
  const text = Array.from({ length: 9 }, (_, i) => paragraph(`s${i}`, 100)).join("\n\n");
  const chunks = chunkText(text, OPTIONS);
  assertEquals(chunks.map((c) => c.seq), chunks.map((_, i) => i));
});

Deno.test("chunk: defaults handle a realistic posting in a few chunks", () => {
  const text = Array.from({ length: 14 }, (_, i) => paragraph(`section${i}`, 300)).join("\n\n");
  const chunks = chunkText(text, DEFAULT_CHUNK_OPTIONS);
  assert(chunks.length >= 3 && chunks.length <= 8, `unexpected chunk count ${chunks.length}`);
});
