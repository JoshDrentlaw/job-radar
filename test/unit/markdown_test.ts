/**
 * The markdown renderer. Two things are being asserted here: that the dialect
 * we actually use renders, and — the part that matters — that nothing in a
 * source document can become markup. The renderer builds a JSX tree, so the
 * escaping is hono's; these tests exist to prove there is no path around it.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Markdown } from "@web/markdown.tsx";

function render(text: string, headingOffset?: number): string {
  return String(
    Markdown({ text, ...(headingOffset !== undefined ? { headingOffset } : {}) }),
  );
}

Deno.test("markdown: paragraphs, emphasis and code spans", () => {
  const html = render("Shipped **payroll** for _hourly_ staff using `pg_notify`.");
  assertStringIncludes(html, "<strong>payroll</strong>");
  assertStringIncludes(html, "<em>hourly</em>");
  assertStringIncludes(html, "<code>pg_notify</code>");
});

Deno.test("markdown: underscores inside a word are left alone", () => {
  const html = render("The column is last_seen_at and it matters.");
  assertStringIncludes(html, "last_seen_at");
  assertEquals(html.includes("<em>"), false);
});

Deno.test("markdown: headings are offset beneath the page outline", () => {
  assertStringIncludes(render("# Roles", 2), "<h3>Roles</h3>");
  assertStringIncludes(render("### Roles", 2), "<h5>Roles</h5>");
  // Never past h6, whatever the offset would compute to.
  assertStringIncludes(render("###### Roles", 2), "<h6>Roles</h6>");
});

Deno.test("markdown: tight lists do not wrap their items in paragraphs", () => {
  const html = render("- one\n- two\n- three");
  assertStringIncludes(html, "<ul><li>one</li><li>two</li><li>three</li></ul>");
});

Deno.test("markdown: ordered lists keep their starting number", () => {
  assertStringIncludes(render("3. third\n4. fourth"), '<ol start="3">');
  assertStringIncludes(render("1. first\n2. second"), "<ol>");
});

Deno.test("markdown: nested list items keep their nesting", () => {
  const html = render("- payroll\n  - commission\n  - hourly\n- benefits");
  assertStringIncludes(html, "<ul><li>");
  assertStringIncludes(html, "<li><p>payroll</p><ul><li>commission</li><li>hourly</li></ul></li>");
});

Deno.test("markdown: fenced code is preserved verbatim, not parsed", () => {
  const html = render("```sql\nSELECT * FROM payroll -- **not bold**\n```");
  assertStringIncludes(html, "<pre><code>SELECT * FROM payroll -- **not bold**</code></pre>");
});

Deno.test("markdown: blockquotes and rules", () => {
  assertStringIncludes(render("> quoted line"), "<blockquote><p>quoted line</p></blockquote>");
  assertStringIncludes(render("---"), "<hr/>");
});

Deno.test("markdown: hard breaks need two trailing spaces", () => {
  assertStringIncludes(render("one  \ntwo"), "one<br/>two");
  assertStringIncludes(render("one\ntwo"), "one two");
});

/* ------------------------------------------------------------- safety ----- */

Deno.test("markdown: raw HTML is text, not markup", () => {
  const html = render('<script>alert("x")</script> and <b>bold?</b>');
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("<b>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("markdown: an img tag in the source cannot reach the document", () => {
  const html = render('<img src=x onerror="alert(1)">');
  assertEquals(html.includes("<img"), false);
  // The word survives as prose, which is the point — it is characters, not an
  // attribute, and the `&lt;` is what proves it.
  assertStringIncludes(html, "&lt;img src=x onerror=");
});

Deno.test("markdown: javascript: and data: destinations are refused", () => {
  for (const scheme of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x"]) {
    const html = render(`[click me](${scheme})`);
    assertStringIncludes(html, "click me");
    assertEquals(html.includes("href"), false, `${scheme} produced an href`);
  }
});

Deno.test("markdown: protocol-relative destinations are refused", () => {
  const html = render("[click me](//evil.example/x)");
  assertEquals(html.includes("href"), false);
});

Deno.test("markdown: http, https and mailto links render with a safe rel", () => {
  const html = render("[docs](https://example.com/a) and [mail](mailto:a@example.com)");
  assertStringIncludes(html, '<a href="https://example.com/a" rel="noreferrer noopener nofollow">');
  assertStringIncludes(html, '<a href="mailto:a@example.com" rel="noreferrer noopener nofollow">');
});

Deno.test("markdown: a quote in a link destination cannot break out of the attribute", () => {
  const html = render('[x](https://example.com/" onmouseover="alert(1))');
  assertEquals(html.includes('" onmouseover="'), false);
  assertStringIncludes(html, "&quot;");
});

Deno.test("markdown: bare URLs become links without swallowing the sentence", () => {
  const html = render("See https://example.com/board, then stop.");
  assertStringIncludes(html, '<a href="https://example.com/board"');
  assertStringIncludes(html, ", then stop.");
});

Deno.test("markdown: images become links because the CSP blocks remote images", () => {
  const html = render("![a chart](https://example.com/c.png)");
  assertEquals(html.includes("<img"), false);
  assertStringIncludes(html, '<a href="https://example.com/c.png"');
  assertStringIncludes(html, "a chart");
});

Deno.test("markdown: an empty document renders nothing at all", () => {
  assertEquals(render(""), '<div class="prose"></div>');
  assertEquals(render("   \n\n  "), '<div class="prose"></div>');
});
