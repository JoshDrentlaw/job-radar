/**
 * Overlapping-chunk splitter for embeddings (§7).
 *
 * Descriptions run long and bury requirements mid-document; whole-document
 * embedding averages the signal away and leaves nothing to quote. Chunks are
 * paragraph-aligned so the quoted passage a match cites reads as prose, and
 * consecutive chunks share a paragraph of overlap so a requirement straddling
 * a boundary is fully inside at least one chunk.
 *
 * "Paragraph-aligned" originally meant "blank-line aligned," full stop — a
 * blank line was the only thing that meant anything to the splitter. In
 * practice that is also where a markdown *block* boundary usually falls, so
 * it worked, until it didn't: a heading with a conventional blank line
 * before its body could get separated from that body, a list written with a
 * blank line between items (also entirely conventional markdown) could get
 * split mid-list, and a blank line *inside* a fenced code block — which
 * isn't a boundary at all — could split the fence itself. `unitsOf` below
 * groups on the same blank-line rule but keeps a heading glued to whatever
 * follows it, keeps consecutive list items glued to each other, and never
 * treats a blank line inside a fence as a break. It is not a markdown
 * parser — no indentation-aware nesting, no lazy continuation lines — just
 * enough pattern-matching to stop those three specific splits.
 *
 * One gap this does not close: `splitOversized` below still has no idea
 * what a fence is, so a single fenced block bigger than `maxChars` — an
 * 1,800+ character code sample — can still be hard-cut mid-fence. Grouping
 * keeps a fence whole up to that size; it does not protect an oversized one.
 *
 * The splitter is deterministic: the same text always produces the same
 * chunks. Bump CHUNKER_VERSION when that stops being true for existing input.
 */

export const CHUNKER_VERSION = "2";

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM_LINE = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;

/**
 * Blank-line-separated units — the same rule `chunkText` always used — except
 * a blank line while a fence is open is content, not a break, so it never
 * ends a unit. Scanned line by line (rather than a regex split-then-mask)
 * so no placeholder character is ever needed for "this was a blank line."
 */
function rawUnitsOf(text: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length === 0) return;
    units.push(current.join("\n").trim());
    current = [];
  };

  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    if (line.trim() === "" && !inFence) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  return units.filter((u) => u !== "");
}

/**
 * The line a heading glues forward from is its *last* line, so a chain of
 * headings with nothing between them keeps gluing to the next real content
 * instead of stopping at the second heading.
 */
function endsWithHeading(unit: string): boolean {
  const lines = unit.split("\n");
  return HEADING_LINE.test(lines[lines.length - 1] ?? "");
}

/**
 * Whether a unit opens with a list marker — stable across repeated merges,
 * since gluing more items on never changes what the first line is.
 */
function startsWithListItem(unit: string): boolean {
  return LIST_ITEM_LINE.test(unit.split("\n")[0] ?? "");
}

/**
 * Re-joins the units a blank line split apart when the source either side of
 * it was one markdown block, not two: a heading always glues to what comes
 * next, and two adjacent list items glue to each other. An intro sentence
 * ahead of a list is deliberately left alone — that split is between two
 * genuinely different units, not one block cut in half.
 */
function glueMarkdownUnits(units: readonly string[]): string[] {
  const glued: string[] = [];
  for (const unit of units) {
    const prev = glued[glued.length - 1];
    const shouldGlue = prev !== undefined &&
      (endsWithHeading(prev) || (startsWithListItem(prev) && startsWithListItem(unit)));
    if (shouldGlue) glued[glued.length - 1] = `${prev}\n\n${unit}`;
    else glued.push(unit);
  }
  return glued;
}

/**
 * Blank-line-separated units, with markdown blocks that a blank line would
 * otherwise cut in half re-glued (see the module doc comment).
 */
function unitsOf(text: string): string[] {
  return glueMarkdownUnits(rawUnitsOf(text));
}

export interface Chunk {
  readonly seq: number;
  /** Verbatim slice of the input — this is what a match quotes. */
  readonly text: string;
}

export interface ChunkOptions {
  /** Soft target; a chunk closes once it reaches this size. */
  readonly targetChars: number;
  /** Hard cap; a single paragraph longer than this is split on line/sentence. */
  readonly maxChars: number;
}

/**
 * ~1,100 characters is roughly 250 tokens of English prose — small enough that
 * one requirement dominates the vector, large enough to keep its context.
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1_100,
  maxChars: 1_800,
};

/** Split an over-long paragraph on line breaks, then sentence ends, then hard. */
function splitOversized(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];

  const parts: string[] = [];
  let remaining = paragraph;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    // Prefer the last line break in the window, then the last sentence end,
    // then the last space; give up and cut hard only for unbroken runs.
    const byLine = window.lastIndexOf("\n");
    const bySentence = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    const bySpace = window.lastIndexOf(" ");
    const cut = byLine > maxChars / 4
      ? byLine
      : bySentence > maxChars / 4
      ? bySentence + 1
      : bySpace > maxChars / 4
      ? bySpace
      : maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining !== "") parts.push(remaining);
  return parts;
}

export function chunkText(
  text: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  if (normalized === "") return [];

  // Markdown-block units (see the module doc comment); oversized ones are
  // pre-split so the accumulator below never has to break inside a unit.
  const paragraphs = unitsOf(normalized).flatMap((p) => splitOversized(p, options.maxChars));

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    const appended = currentLength + (current.length > 0 ? 2 : 0) + paragraph.length;
    if (current.length > 0 && appended > options.targetChars) {
      chunks.push(current.join("\n\n"));
      // Overlap: the next chunk starts with the paragraph that closed this
      // one, so nothing straddling the boundary is lost to either side.
      const carry = current[current.length - 1]!;
      current = carry.length < options.targetChars / 2 ? [carry] : [];
      currentLength = current.length > 0 ? carry.length : 0;
    }
    current.push(paragraph);
    currentLength += (current.length > 1 ? 2 : 0) + paragraph.length;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));

  // A trailing chunk that is pure overlap of the previous one adds no signal.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!;
    const previous = chunks[chunks.length - 2]!;
    if (previous.endsWith(last)) chunks.pop();
  }

  return chunks.map((chunk, seq) => ({ seq, text: chunk }));
}
