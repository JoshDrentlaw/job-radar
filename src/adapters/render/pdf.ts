/**
 * PDF renderer (§8): a minimal, dependency-free PDF 1.4 writer.
 *
 * Uses the three core Helvetica fonts every reader ships, uncompressed content
 * streams, no CreationDate, no document ID — the file is a pure function of
 * the RenderableResume IR, which is what "same variant, same bytes, twice"
 * (§15) demands. A library would have to be scrubbed of timestamps and
 * randomness to promise that; this cannot contain either.
 *
 * Consumes the IR only; it knows nothing about facts, variants or Postgres.
 */

import type { RenderableResume, ResumeSection } from "@domain/dossier/resume.ts";
import { contactLine } from "@domain/dossier/resume.ts";

/* -------------------------------------------------- font metrics -------- */

/**
 * Helvetica AFM widths for ASCII 32–126, in 1/1000 em. Widths only steer line
 * wrapping; a slightly-off width wraps a hair early, it does not corrupt the
 * file.
 */
// deno-fmt-ignore
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// deno-fmt-ignore
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

type FontName = "regular" | "bold" | "oblique";

/** WinAnsi code points for the non-ASCII characters resumes actually contain. */
const WINANSI_EXTRAS = new Map<string, number>([
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
]);

function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (code >= 0xA0 && code <= 0xFF) bytes.push(code);
    else if (WINANSI_EXTRAS.has(ch)) bytes.push(WINANSI_EXTRAS.get(ch)!);
    else bytes.push(0x3F); // '?': unmappable, visible rather than silently gone
  }
  return bytes;
}

function widthOf(bytes: readonly number[], font: FontName, size: number): number {
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const byte of bytes) {
    total += byte >= 32 && byte <= 126 ? table[byte - 32]! : 556;
  }
  return (total / 1000) * size;
}

/** Greedy word wrap against real font metrics. */
function wrap(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && widthOf(encodeWinAnsi(candidate), font, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

/* -------------------------------------------------- layout --------------- */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const FONT_REFS: Record<FontName, string> = {
  regular: "/F1",
  bold: "/F2",
  oblique: "/F3",
};

function escapePdfString(bytes: readonly number[]): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5C) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= 32 && byte <= 126) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return out;
}

/** Accumulates content-stream operators, breaking pages as the cursor sinks. */
class Layout {
  readonly pages: string[][] = [];
  #ops: string[] = [];
  #y = PAGE_HEIGHT - MARGIN;

  constructor() {
    this.pages.push(this.#ops);
  }

  #ensureRoom(needed: number): void {
    if (this.#y - needed < MARGIN) {
      this.#ops = [];
      this.pages.push(this.#ops);
      this.#y = PAGE_HEIGHT - MARGIN;
    }
  }

  text(
    content: string,
    opts: { font: FontName; size: number; x?: number; gray?: number; lineHeight?: number },
  ): void {
    const lineHeight = opts.lineHeight ?? opts.size * 1.25;
    const x = MARGIN + (opts.x ?? 0);
    const lines = wrap(content, opts.font, opts.size, CONTENT_WIDTH - (opts.x ?? 0));
    for (const line of lines) {
      this.#ensureRoom(lineHeight);
      this.#y -= lineHeight;
      const gray = opts.gray ?? 0;
      this.#ops.push(
        `BT ${FONT_REFS[opts.font]} ${opts.size} Tf ${gray} g ` +
          `1 0 0 1 ${x} ${this.#y} Tm (${escapePdfString(encodeWinAnsi(line))}) Tj ET`,
      );
    }
  }

  /** A bullet: dash in the gutter, wrapped text with a hanging indent. */
  bullet(content: string, opts: { size: number }): void {
    const indent = 14;
    const lineHeight = opts.size * 1.3;
    const lines = wrap(content, "regular", opts.size, CONTENT_WIDTH - indent);
    for (let i = 0; i < lines.length; i++) {
      this.#ensureRoom(lineHeight);
      this.#y -= lineHeight;
      const prefix = i === 0
        ? `BT ${FONT_REFS.regular} ${opts.size} Tf 0 g 1 0 0 1 ${MARGIN} ${this.#y} Tm ` +
          `(${escapePdfString(encodeWinAnsi("–"))}) Tj ET `
        : "";
      this.#ops.push(
        prefix +
          `BT ${FONT_REFS.regular} ${opts.size} Tf 0 g ` +
          `1 0 0 1 ${MARGIN + indent} ${this.#y} Tm ` +
          `(${escapePdfString(encodeWinAnsi(lines[i]!))}) Tj ET`,
      );
    }
  }

  rule(): void {
    this.#ensureRoom(4);
    this.#y -= 4;
    this.#ops.push(
      `0.6 G 0.5 w ${MARGIN} ${this.#y} m ${PAGE_WIDTH - MARGIN} ${this.#y} l S`,
    );
  }

  gap(points: number): void {
    // Whitespace never forces a page break on its own.
    this.#y = Math.max(this.#y - points, MARGIN);
  }
}

function layoutSection(layout: Layout, section: ResumeSection): void {
  if (section.kind === "summary") {
    for (const text of section.paragraphs) {
      layout.text(text, { font: "regular", size: 10 });
      layout.gap(4);
    }
    return;
  }

  const heading = section.kind === "skills" ? "Skills" : section.heading;
  layout.gap(10);
  layout.text(heading.toUpperCase(), { font: "bold", size: 10.5 });
  layout.rule();
  layout.gap(4);

  if (section.kind === "skills") {
    layout.text(section.items.join("  ·  "), { font: "regular", size: 10 });
    layout.gap(2);
    return;
  }

  for (const entry of section.entries) {
    layout.gap(4);
    layout.text(entry.title, { font: "bold", size: 10.5 });
    const meta = [entry.organization, entry.dates]
      .filter((v): v is string => v !== undefined)
      .join("  ·  ");
    if (meta !== "") {
      layout.text(meta, { font: "oblique", size: 9, gray: 0.35 });
    }
    layout.gap(2);
    for (const bullet of entry.bullets) {
      layout.bullet(bullet, { size: 10 });
    }
  }
}

/* -------------------------------------------------- assembly ------------- */

export function renderResumePdf(resume: RenderableResume): Uint8Array {
  const layout = new Layout();

  layout.text(resume.identity.name, { font: "bold", size: 17, lineHeight: 19 });
  const contact = contactLine(resume.identity);
  if (contact !== "") {
    layout.gap(2);
    layout.text(contact, { font: "regular", size: 9, gray: 0.35 });
  }
  layout.gap(6);
  for (const section of resume.sections) layoutSection(layout, section);

  /*
   * Object plan (fixed, so offsets are reproducible):
   *   1 catalog · 2 pages · 3-5 fonts · then per page: page object, stream.
   */
  const objects: string[] = [];
  const pageCount = layout.pages.length;
  const firstPageObj = 6;

  const pageRefs = Array.from(
    { length: pageCount },
    (_, i) => `${firstPageObj + i * 2} 0 R`,
  );

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageCount} >>`);
  for (
    const [ref, base] of [["F1", "Helvetica"], ["F2", "Helvetica-Bold"], [
      "F3",
      "Helvetica-Oblique",
    ]] as const
  ) {
    void ref;
    objects.push(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
    );
  }

  const fontDict = "<< /F1 3 0 R /F2 4 0 R /F3 5 0 R >>";
  for (let i = 0; i < pageCount; i++) {
    const streamObj = firstPageObj + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font ${fontDict} >> /Contents ${streamObj} 0 R >>`,
    );
    const stream = layout.pages[i]!.join("\n");
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  // Content is WinAnsi-escaped ASCII throughout, so byte length === length.
  return new TextEncoder().encode(body);
}
