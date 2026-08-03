import { assert, assertEquals } from "@std/assert";
import type { RenderableResume } from "@domain/dossier/resume.ts";
import { renderResumePdf } from "@adapters/render/pdf.ts";
import { renderResumeDocx } from "@adapters/render/docx.ts";
import { buildZip, crc32 } from "@adapters/render/zip.ts";

const RESUME: RenderableResume = {
  identity: {
    name: "Josh Example",
    email: "josh@example.test",
    location: "Duluth, MN",
    links: ["github.com/example"],
  },
  sections: [
    { kind: "summary", paragraphs: ["Programmer of fifteen years — systems, data, web."] },
    {
      kind: "experience",
      heading: "Experience",
      entries: [
        {
          title: "Programmer",
          organization: "Acme Corp",
          dates: "Mar 2020 – Present",
          bullets: [
            "Built an ingest pipeline processing (millions) of rows nightly with \\ backslashes.",
            "A very long bullet meant to exercise line wrapping in both renderers: " +
            "it keeps going with plenty of ordinary prose so that the greedy wrap has to " +
            "produce several lines from a single logical statement about work that was done.",
          ],
        },
      ],
    },
    { kind: "skills", items: ["TypeScript", "Deno", "Postgres"] },
  ],
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("crc32 matches the reference vector", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
});

Deno.test("zip: deterministic and structurally sound", () => {
  const entries = [
    { path: "a.txt", data: new TextEncoder().encode("alpha") },
    { path: "dir/b.txt", data: new TextEncoder().encode("beta") },
  ];
  const first = buildZip(entries);
  const second = buildZip(entries);
  assertEquals(first, second);

  // Local header magic at the start, end-of-central-directory magic present.
  assertEquals([...first.slice(0, 4)], [0x50, 0x4B, 0x03, 0x04]);
  const tail = first.slice(-22);
  assertEquals([...tail.slice(0, 4)], [0x50, 0x4B, 0x05, 0x06]);
  assertEquals(tail[10]! | (tail[11]! << 8), 2); // entry count
});

Deno.test("pdf: same resume, same bytes, twice", async () => {
  const first = renderResumePdf(RESUME);
  const second = renderResumePdf(RESUME);
  assertEquals(await sha256(first), await sha256(second));
  assertEquals(first, second);
});

Deno.test("pdf: structurally a PDF with the expected text", () => {
  const text = new TextDecoder().decode(renderResumePdf(RESUME));
  assert(text.startsWith("%PDF-1.4\n"));
  assert(text.trimEnd().endsWith("%%EOF"));
  assert(text.includes("/BaseFont /Helvetica"));
  assert(text.includes("Josh Example"));
  assert(text.includes("EXPERIENCE"));
  // Parentheses and backslashes must be escaped inside PDF strings.
  assert(text.includes("\\(millions\\)"));
  assert(text.includes("\\\\ backslashes"));
  // No timestamps, no ID — the determinism is structural, not luck.
  assert(!text.includes("/CreationDate"));
  assert(!text.includes("/ID"));
});

Deno.test("pdf: long content flows onto additional pages", () => {
  const bullets = Array.from(
    { length: 80 },
    (_, i) => `Bullet number ${i} with enough prose to occupy a full line of the page body.`,
  );
  const long: RenderableResume = {
    identity: { name: "X", links: [] },
    sections: [{
      kind: "experience",
      heading: "Experience",
      entries: [{ title: "Role", bullets }],
    }],
  };
  const text = new TextDecoder().decode(renderResumePdf(long));
  const countMatch = /\/Count (\d+)/.exec(text);
  assert(countMatch !== null && Number(countMatch[1]) >= 2, "expected multiple pages");
  assert(text.includes("Bullet number 79"));
});

Deno.test("docx: same resume, same bytes, twice", async () => {
  const first = renderResumeDocx(RESUME);
  const second = renderResumeDocx(RESUME);
  assertEquals(await sha256(first), await sha256(second));
});

Deno.test("docx: package contains the document with escaped text", () => {
  const bytes = renderResumeDocx(RESUME);
  // Entries are stored uncompressed, so the XML is directly visible.
  const text = new TextDecoder("latin1").decode(bytes);
  assert(text.includes("[Content_Types].xml"));
  assert(text.includes("word/document.xml"));
  assert(text.includes("Josh Example"));
  assert(text.includes("TypeScript"));
  assert(!text.includes("<w:t></w:t>"));
});

Deno.test("docx: xml-special characters in facts are escaped", () => {
  const tricky: RenderableResume = {
    identity: { name: "A & B <Consulting>", links: [] },
    sections: [{ kind: "skills", items: ['C++ & "generics"'] }],
  };
  const text = new TextDecoder("latin1").decode(renderResumeDocx(tricky));
  assert(text.includes("A &amp; B &lt;Consulting&gt;"));
  assert(text.includes("C++ &amp; &quot;generics&quot;"));
});
