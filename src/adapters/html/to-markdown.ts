/**
 * HTML to markdown for posting descriptions.
 *
 * The tag distribution was measured across 657 postings on three live
 * Greenhouse boards. In descending frequency: li, p, strong, div, h2, ul, span,
 * a, br, u, h4, h3, em, h1, ol, hr. That is the whole vocabulary in practice,
 * and the converter covers it plus a conservative tail (blockquote, code, pre,
 * table) for the adapters still to come.
 *
 * Two deliberate choices:
 *
 *   - Nothing is backslash-escaped. This text is embedded for semantic matching
 *     (§7) and displayed as preformatted text; it is not round-tripped through
 *     a markdown parser. Escaping would put backslashes into the embedding
 *     input and in front of every heading and bullet on screen, which costs
 *     something real to defend against a risk that is currently theoretical.
 *
 *   - `<u>` becomes plain text. Markdown has no underline, and inventing
 *     emphasis the source did not express would be a small lie in a file whose
 *     whole job is fidelity.
 */

import { DOMParser, type Element, type Node } from "@b-fuze/deno-dom";

/** Node.TEXT_NODE / Node.ELEMENT_NODE, spelled out to avoid a DOM global. */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "TEMPLATE"]);

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "DD",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "THEAD",
  "TR",
  "UL",
]);

/**
 * Greenhouse entity-encodes the whole description with exactly these five
 * entities (verified: &lt; &gt; &quot; &amp; &#39; and nothing else). Decoding
 * happens in one pass rather than sequential replaces, so `&amp;lt;` decodes to
 * the literal text `&lt;` instead of collapsing all the way to `<`.
 */
const BASIC_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
};

export function decodeBasicEntities(text: string): string {
  return text.replace(/&(?:lt|gt|quot|amp|apos|#39);/g, (match) => BASIC_ENTITIES[match] ?? match);
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\s   ]+/g, " ");
}

interface Context {
  /** Nesting depth for list indentation. */
  readonly listDepth: number;
  /** Ordered-list counter for the current level, or null inside a bullet list. */
  readonly orderedIndex: number | null;
  readonly inPre: boolean;
}

const ROOT: Context = { listDepth: 0, orderedIndex: null, inPre: false };

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function tagOf(node: Node): string {
  return isElement(node) ? node.tagName.toUpperCase() : "";
}

function renderChildren(node: Node, ctx: Context): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) out += renderNode(child, ctx);
  return out;
}

/** Trim a rendered inline run without losing a meaningful single space. */
function inline(node: Node, ctx: Context): string {
  return renderChildren(node, ctx).replace(/\s+/g, " ").trim();
}

function block(content: string): string {
  const trimmed = content.trim();
  return trimmed === "" ? "" : `\n\n${trimmed}\n\n`;
}

function renderList(node: Element, ctx: Context, ordered: boolean): string {
  const items = Array.from(node.childNodes).filter((child) => tagOf(child) === "LI");
  const indent = "  ".repeat(ctx.listDepth);
  const childCtx: Context = { ...ctx, listDepth: ctx.listDepth + 1, orderedIndex: null };

  const lines = items.map((item, index) => {
    const marker = ordered ? `${index + 1}.` : "-";
    const body = renderChildren(item, childCtx).trim();
    if (body === "") return "";
    // Continuation lines of a multi-line item align under the marker.
    const [first = "", ...rest] = body.split("\n");
    const continuation = rest
      .map((line) => (line.trim() === "" ? "" : `${indent}${" ".repeat(marker.length + 1)}${line}`))
      .join("\n");
    return `${indent}${marker} ${first}${rest.length > 0 ? `\n${continuation}` : ""}`;
  }).filter((line) => line !== "");

  return lines.length === 0 ? "" : `\n\n${lines.join("\n")}\n\n`;
}

function renderTable(node: Element, ctx: Context): string {
  const rows = Array.from(node.querySelectorAll("tr"));
  if (rows.length === 0) return "";

  const rendered = rows.map((row) =>
    Array.from((row as Element).querySelectorAll("th, td"))
      .map((cell) => inline(cell as Element, ctx).replace(/\|/g, "\\|"))
  );
  const width = Math.max(...rendered.map((cells) => cells.length));
  if (width === 0) return "";

  const pad = (cells: string[]) => {
    const filled = [...cells];
    while (filled.length < width) filled.push("");
    return `| ${filled.join(" | ")} |`;
  };

  const [header = [], ...body] = rendered;
  const divider = `| ${Array(width).fill("---").join(" | ")} |`;
  return `\n\n${[pad(header), divider, ...body.map(pad)].join("\n")}\n\n`;
}

function renderNode(node: Node, ctx: Context): string {
  if (node.nodeType === TEXT_NODE) {
    const raw = node.nodeValue ?? "";
    return ctx.inPre ? raw : collapseWhitespace(raw);
  }
  if (!isElement(node)) return "";

  const tag = node.tagName.toUpperCase();
  if (DROPPED_TAGS.has(tag)) return "";

  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      return "\n\n---\n\n";

    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Number(tag[1]);
      const text = inline(node, ctx);
      return text === "" ? "" : `\n\n${"#".repeat(level)} ${text}\n\n`;
    }

    case "STRONG":
    case "B": {
      const text = inline(node, ctx);
      return text === "" ? "" : `**${text}**`;
    }

    case "EM":
    case "I": {
      const text = inline(node, ctx);
      return text === "" ? "" : `*${text}*`;
    }

    case "CODE": {
      if (ctx.inPre) return renderChildren(node, ctx);
      const text = inline(node, ctx);
      return text === "" ? "" : `\`${text}\``;
    }

    case "PRE": {
      const text = renderChildren(node, { ...ctx, inPre: true }).replace(/\n+$/, "");
      return text.trim() === "" ? "" : `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
    }

    case "A": {
      const href = node.getAttribute("href")?.trim() ?? "";
      const text = inline(node, ctx);
      if (text === "") return "";
      // Skip javascript: and other non-navigational schemes rather than
      // embedding them in a document a human will read.
      if (href === "" || /^javascript:/i.test(href)) return text;
      return `[${text}](${href.replace(/[()]/g, encodeURIComponent)})`;
    }

    case "IMG": {
      const alt = node.getAttribute("alt")?.trim() ?? "";
      return alt === "" ? "" : `![${alt}]()`;
    }

    case "UL":
      return renderList(node, ctx, false);
    case "OL":
      return renderList(node, ctx, true);
    case "LI":
      // Only reachable for a stray <li> outside a list.
      return block(renderChildren(node, ctx));

    case "BLOCKQUOTE": {
      const text = renderChildren(node, ctx).trim();
      if (text === "") return "";
      const quoted = text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
      return `\n\n${quoted}\n\n`;
    }

    case "TABLE":
      return renderTable(node, ctx);

    // Underline has no markdown equivalent; keep the words, drop the styling.
    case "U":
    case "SPAN":
    case "FONT":
    case "SMALL":
    case "LABEL":
      return renderChildren(node, ctx);

    default:
      return BLOCK_TAGS.has(tag) ? block(renderChildren(node, ctx)) : renderChildren(node, ctx);
  }
}

/** Collapse the blank lines that block rendering generates liberally. */
function tidy(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

export interface HtmlToMarkdownOptions {
  /**
   * Decode the five basic XML entities before parsing. Greenhouse serves its
   * descriptions entity-encoded; most feeds do not.
   */
  readonly decodeEntitiesFirst?: boolean;
}

export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  if (html.trim() === "") return "";

  const source = options.decodeEntitiesFirst === true ? decodeBasicEntities(html) : html;
  const document = new DOMParser().parseFromString(source, "text/html");
  if (!document?.body) return tidy(collapseWhitespace(source));

  return tidy(renderChildren(document.body, ROOT));
}
