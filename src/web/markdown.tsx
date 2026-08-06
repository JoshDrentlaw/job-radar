/** @jsxImportSource hono/jsx */

/**
 * Markdown → JSX.
 *
 * Three places in this application hold markdown: profile facets (authored),
 * posting descriptions (converted from the feed's HTML), and application notes.
 * All three were rendered as preformatted source, which is readable but not
 * what the author wrote.
 *
 * The important property here is structural rather than aesthetic: this
 * produces a JSX tree, never an HTML string. There is no `dangerouslySetInner-
 * HTML` anywhere in the application and no way to add one through this file, so
 * every character still leaves through hono's escaping. A facet containing
 * `<script>` renders the seven characters `<script>` and there is no code path
 * that could do otherwise. Raw HTML in the source is therefore *not* passed
 * through — deliberately, and it is the one place this diverges from CommonMark.
 *
 * The dialect is the measured one: what the HTML→markdown converter emits, plus
 * what a person writing prose about their own experience actually types.
 * Tables, footnotes, reference links and setext headings are not implemented,
 * and unimplemented syntax degrades to its own source text rather than
 * disappearing.
 */

import type { Child, FC } from "hono/jsx";

/* ----------------------------------------------------------- block rules -- */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^([ \t]{0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^([ \t]{0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;

const MAX_HEADING_LEVEL = 6;

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) ||
    QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function at(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

/* ------------------------------------------------------------- inline ----- */

/** The set CommonMark allows a backslash to escape. */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Schemes that may appear in an href. Everything else — `javascript:`, `data:`,
 * a protocol-relative `//host` — renders as text, because a link the reader
 * cannot predict from what they see is the whole attack.
 */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  if (/^(?:https?:|mailto:)/i.test(url)) return url;
  // Any other explicit scheme is refused rather than guessed at.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  if (url.startsWith("//")) return null;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  return null;
}

const ExternalLink: FC<{ href: string; title?: string; children: Child }> = (props) => (
  <a
    href={props.href}
    rel="noreferrer noopener nofollow"
    {...(props.title ? { title: props.title } : {})}
  >
    {props.children}
  </a>
);

function runLength(text: string, start: number, ch: string): number {
  let length = 0;
  while (text.charAt(start + length) === ch) length++;
  return length;
}

/** `[label](dest "title")`, with nested brackets and balanced parens. */
function parseLinkAt(
  text: string,
  start: number,
): { label: string; dest: string; title: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || i >= text.length) return null;

  const labelEnd = i;
  if (text.charAt(labelEnd + 1) !== "(") return null;

  let parens = 0;
  let j = labelEnd + 1;
  for (; j < text.length; j++) {
    const ch = text.charAt(j);
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens === 0) break;
    }
  }
  if (parens !== 0 || j >= text.length) return null;

  const inner = text.slice(labelEnd + 2, j).trim();
  const titled = /^(\S*)\s+["'(](.*)["')]$/s.exec(inner);
  return {
    label: text.slice(start + 1, labelEnd),
    dest: titled === null ? inner : (titled[1] ?? ""),
    title: titled === null ? "" : (titled[2] ?? ""),
    end: j + 1,
  };
}

/**
 * Finds the delimiter run that closes an emphasis span. A closer may not sit
 * directly after whitespace, and an underscore closer may not sit inside a
 * word — which is what keeps `snake_case_names` intact.
 */
function findEmphasisClose(
  text: string,
  from: number,
  delimiter: string,
  underscore: boolean,
): number {
  let cursor = from;
  while (cursor < text.length) {
    const index = text.indexOf(delimiter, cursor);
    if (index === -1) return -1;
    if (index === from) {
      cursor = index + 1;
      continue;
    }
    const before = text.charAt(index - 1);
    const after = text.charAt(index + delimiter.length);
    if (/\s/.test(before) || before === "\\" || (underscore && /[\p{L}\p{N}]/u.test(after))) {
      cursor = index + delimiter.length;
      continue;
    }
    return index;
  }
  return -1;
}

function emphasisNode(size: number, children: Child[]): Child {
  if (size >= 3) {
    return (
      <strong>
        <em>{children}</em>
      </strong>
    );
  }
  if (size === 2) return <strong>{children}</strong>;
  return <em>{children}</em>;
}

/** Trailing punctuation is far more often a sentence than part of the URL. */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?'\"".includes(url.charAt(end - 1))) end--;
  // A closing paren only belongs to the URL if the URL opened one.
  while (end > 0 && url.charAt(end - 1) === ")") {
    const slice = url.slice(0, end);
    const opens = (slice.match(/\(/g) ?? []).length;
    const closes = (slice.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    end--;
  }
  return url.slice(0, end);
}

function parseInline(text: string): Child[] {
  const out: Child[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer !== "") {
      out.push(buffer);
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === "\\" && ESCAPABLE.test(text.charAt(i + 1))) {
      buffer += text.charAt(i + 1);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = runLength(text, i, "`");
      const close = text.indexOf("`".repeat(run), i + run);
      if (close !== -1) {
        let content = text.slice(i + run, close);
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
          content = content.slice(1, -1);
        }
        flush();
        out.push(<code>{content}</code>);
        i = close + run;
        continue;
      }
    }

    if (ch === "<") {
      const close = text.indexOf(">", i + 1);
      const inner = close === -1 ? "" : text.slice(i + 1, close);
      if (inner !== "" && !/\s/.test(inner)) {
        const isMail = /^[^@<>]+@[^@<>]+\.[^@<>]+$/.test(inner);
        const href = isMail ? `mailto:${inner}` : safeHref(inner);
        if (href !== null) {
          flush();
          out.push(<ExternalLink href={href}>{inner}</ExternalLink>);
          i = close + 1;
          continue;
        }
      }
    }

    // An image cannot load — the CSP allows `img-src 'self' data:` and nothing
    // else — so it becomes a labelled link rather than a broken frame.
    if (ch === "!" && text.charAt(i + 1) === "[") {
      const image = parseLinkAt(text, i + 1);
      if (image !== null) {
        const href = safeHref(image.dest);
        if (href !== null) {
          flush();
          out.push(
            <ExternalLink href={href} title="Image — remote images are blocked by this app's CSP">
              {image.label === "" ? image.dest : image.label}
            </ExternalLink>,
          );
          i = image.end;
          continue;
        }
      }
    }

    if (ch === "[") {
      const link = parseLinkAt(text, i);
      if (link !== null) {
        const href = safeHref(link.dest);
        flush();
        if (href === null) {
          // A refused destination still shows its label; the URL is simply not
          // clickable, and saying so beats silently dropping it.
          out.push(
            <span title={`Link not rendered: unsupported destination ${link.dest}`}>
              {parseInline(link.label)}
            </span>,
          );
        } else {
          out.push(
            <ExternalLink href={href} {...(link.title !== "" ? { title: link.title } : {})}>
              {parseInline(link.label)}
            </ExternalLink>,
          );
        }
        i = link.end;
        continue;
      }
    }

    if (ch === "~" && text.charAt(i + 1) === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close !== -1) {
        flush();
        out.push(<s>{parseInline(text.slice(i + 2, close))}</s>);
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const underscore = ch === "_";
      const openerOk = !/\s/.test(text.charAt(i + runLength(text, i, ch))) &&
        (!underscore || !/[\p{L}\p{N}]/u.test(text.charAt(i - 1)));
      if (openerOk) {
        const size = Math.min(runLength(text, i, ch), 3);
        const delimiter = ch.repeat(size);
        const close = findEmphasisClose(text, i + size, delimiter, underscore);
        if (close !== -1) {
          flush();
          out.push(emphasisNode(size, parseInline(text.slice(i + size, close))));
          i = close + size;
          continue;
        }
      }
    }

    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const before = text.charAt(i - 1);
      if (before === "" || /[\s(]/.test(before)) {
        const raw = text.slice(i).split(/[\s<]/)[0] ?? "";
        const url = trimUrlTail(raw);
        if (url.length > 8) {
          flush();
          out.push(<ExternalLink href={url}>{url}</ExternalLink>);
          i += url.length;
          continue;
        }
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return out;
}

/** Soft breaks join with a space; two trailing spaces or a backslash keep one. */
function parseParagraph(lines: readonly string[]): Child[] {
  const out: Child[] = [];
  lines.forEach((line, index) => {
    const hard = /[ \t]{2,}$/.test(line) || line.endsWith("\\");
    out.push(...parseInline(line.replace(/\\$/, "").trim()));
    if (index < lines.length - 1) out.push(hard ? <br /> : " ");
  });
  return out;
}

/* -------------------------------------------------------------- blocks ---- */

function headingNode(level: number, children: Child[]): Child {
  switch (Math.min(Math.max(level, 1), MAX_HEADING_LEVEL)) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    default:
      return <h6>{children}</h6>;
  }
}

function parseList(
  lines: readonly string[],
  start: number,
  headingOffset: number,
): { node: Child; next: number } {
  const ordered = ORDERED.test(at(lines, start));
  const items: string[][] = [];
  let startNumber = 1;
  let i = start;

  while (i < lines.length) {
    const line = at(lines, i);
    if (RULE.test(line)) break;
    const match = ordered ? ORDERED.exec(line) : BULLET.exec(line);
    if (match === null) break;

    const indent = (match[1] ?? "").length;
    const marker = ordered ? `${match[2] ?? ""}${match[3] ?? ""}` : (match[2] ?? "-");
    const gap = (ordered ? match[4] : match[3]) ?? " ";
    const rest = (ordered ? match[5] : match[4]) ?? "";
    const contentIndent = indent + marker.length + gap.length;
    if (items.length === 0 && ordered) startNumber = Number(match[2] ?? "1");

    const body = [rest];
    i++;
    while (i < lines.length) {
      const current = at(lines, i);
      if (current.trim() === "") {
        const following = at(lines, i + 1);
        if (following.trim() === "" || leadingSpaces(following) < contentIndent) break;
        body.push("");
        i++;
        continue;
      }
      if (leadingSpaces(current) >= contentIndent) {
        body.push(current.slice(contentIndent));
        i++;
        continue;
      }
      // Lazy continuation: a wrapped line that was never indented.
      if (!isBlockStart(current)) {
        body.push(current.trim());
        i++;
        continue;
      }
      break;
    }
    items.push(body);
  }

  const children = items.map((body, index) => {
    const simple = !body.some((line) => line.trim() === "" || isBlockStart(line));
    return <li key={index}>{simple ? parseParagraph(body) : parseBlocks(body, headingOffset)}</li>;
  });

  const node = ordered
    ? <ol {...(startNumber !== 1 ? { start: startNumber } : {})}>{children}</ol>
    : <ul>{children}</ul>;
  return { node, next: i };
}

function parseBlocks(lines: readonly string[], headingOffset: number): Child[] {
  const out: Child[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(lines, i);
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const closer = new RegExp(`^ {0,3}\\${marker.charAt(0)}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(at(lines, i))) {
        body.push(at(lines, i));
        i++;
      }
      i++; // the closing fence, or the end of input
      out.push(<pre><code>{body.join("\n")}</code></pre>);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push(
        headingNode((heading[1] ?? "#").length + headingOffset, parseInline(heading[2] ?? "")),
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr />);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && at(lines, i).trim() !== "") {
        const current = at(lines, i);
        body.push(QUOTE.test(current) ? current.replace(QUOTE, "") : current);
        i++;
      }
      out.push(<blockquote>{parseBlocks(body, headingOffset)}</blockquote>);
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const list = parseList(lines, i, headingOffset);
      out.push(list.node);
      i = list.next;
      continue;
    }

    const body: string[] = [];
    while (i < lines.length) {
      const current = at(lines, i);
      if (current.trim() === "") break;
      if (body.length > 0 && isBlockStart(current)) break;
      body.push(current);
      i++;
    }
    out.push(<p>{parseParagraph(body)}</p>);
  }

  return out;
}

/* --------------------------------------------------------------- entry ---- */

export interface MarkdownOptions {
  /**
   * Added to every heading level, so a facet's `#` becomes an `<h3>` under the
   * page's `<h1>` and its panel's `<h2>`. Document outline over authored level.
   */
  readonly headingOffset?: number;
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): Child[] {
  const normalized = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  return parseBlocks(normalized.split("\n"), options.headingOffset ?? 2);
}

/**
 * Rendered markdown. `.prose` is the only styling hook; `clamp` caps the height
 * so a long facet does not push everything else off the page.
 */
export const Markdown: FC<{
  text: string;
  headingOffset?: number;
  clamp?: boolean;
}> = (props) => (
  <div class={props.clamp ? "prose prose-clamp" : "prose"}>
    {renderMarkdown(props.text, { headingOffset: props.headingOffset ?? 2 })}
  </div>
);
