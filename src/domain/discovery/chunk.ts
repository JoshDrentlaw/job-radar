/**
 * Overlapping-chunk splitter for embeddings (§7).
 *
 * Descriptions run long and bury requirements mid-document; whole-document
 * embedding averages the signal away and leaves nothing to quote. Chunks are
 * paragraph-aligned so the quoted passage a match cites reads as prose, and
 * consecutive chunks share a paragraph of overlap so a requirement straddling
 * a boundary is fully inside at least one chunk.
 *
 * The splitter is deterministic: the same text always produces the same
 * chunks. Bump CHUNKER_VERSION when that stops being true for existing input.
 */

export const CHUNKER_VERSION = "1";

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

  // Paragraphs are blank-line separated; oversized ones are pre-split so the
  // accumulator below never has to break inside a unit.
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .flatMap((p) => splitOversized(p, options.maxChars));

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
