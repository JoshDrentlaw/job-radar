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

/* --------------------------------------- markdown-block grouping --------- */

Deno.test("chunk: a heading is never separated from the body that follows it", () => {
  const text =
    `${paragraph("intro", 200)}\n\n# Commission\n\n${paragraph("commission body", 200)}\n\n` +
    `# Accounting\n\n${paragraph("accounting body", 200)}`;
  const chunks = chunkText(text, OPTIONS);
  for (const chunk of chunks) {
    // Every heading line in a chunk must have more than itself in that chunk.
    const lines = chunk.text.split("\n");
    lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) {
        assert(
          lines.slice(i + 1).some((l) => l.trim() !== ""),
          `heading "${line}" has nothing after it in its own chunk`,
        );
      }
    });
  }
});

Deno.test("chunk: a chain of headings glues through to the real content", () => {
  const chunks = chunkText(
    "# Section\n\n## Subsection\n\nBody text finally arrives here.",
    OPTIONS,
  );
  assertEquals(chunks.length, 1);
  assert(chunks[0]!.text.includes("Body text finally arrives here."));
});

Deno.test("chunk: a loose list (blank line between items) never loses an item to a chunk boundary", () => {
  // Small enough that the whole glued list stays under maxChars — a list
  // too big to fit is the same, separate "oversized unit" case a fence too
  // big to fit is (see the fence test above), not what this test is about.
  const items = Array.from({ length: 6 }, (_, i) => `- ${paragraph(`item${i}`, 20)}`);
  const text = `Services I built:\n\n${items.join("\n\n")}`;
  const chunks = chunkText(text, OPTIONS);
  // The whole list is one unit now, so it lands in exactly one chunk.
  const withList = chunks.filter((c) => items.some((item) => c.text.includes(item)));
  assertEquals(withList.length, 1, "the list should not be split across chunks");
  for (const item of items) {
    assert(withList[0]!.text.includes(item), `missing list item: ${item.slice(0, 20)}`);
  }
});

Deno.test("chunk: a tight list (no blank lines) is unaffected — it was already one unit", () => {
  const text =
    "Services I built:\n\n- Payroll export\n- Commission calculator\n- Time sheet generator";
  const chunks = chunkText(text, DEFAULT_CHUNK_OPTIONS);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0]!.text, text);
});

Deno.test("chunk: a blank line inside a fenced code block is not a chunk boundary", () => {
  const text =
    "Here is the core loop:\n\n```php\nfunction total($rows) {\n\n    return array_sum($rows);\n}\n```\n\nThat's the gist.";
  const chunks = chunkText(text, DEFAULT_CHUNK_OPTIONS);
  assertEquals(
    chunks.length,
    1,
    "well under maxChars, so the fence should stay whole in one chunk",
  );
  assertEquals(chunks[0]!.text, text);
});

Deno.test("chunk: a fence bigger than maxChars can still be hard-cut — a known, documented gap", () => {
  const body = paragraph("fenceline", 2_000).replaceAll(" ", "\n");
  const text = `\`\`\`\n${body}\n\`\`\``;
  const chunks = chunkText(text, OPTIONS);
  assert(
    chunks.length > 1,
    "an oversized fence still gets split — grouping only protects it up to maxChars",
  );
});
