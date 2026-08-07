# Profile — `/profile`

The input side of matching. A **facet** is one angle on your experience — `backend`,
`data-pipeline`, `infra` — written as long-form markdown. This is not a job-category picker: two
facets that would match the same postings aren't earning their keep as separate facets, and the
page's own copy warns against splitting them that finely.

## Using it

- **Create a facet**: a short **name** and a markdown **content** field. The form opens
  automatically if you have no facets yet.
- Each facet card shows its rendered markdown with the editor folded away behind an **Edit this
  facet** disclosure — editing exposes **name**, an **active** checkbox (inactive facets are
  excluded from embedding and matching), and the content textarea.
- **Delete** is a genuine hard delete, unlike the retire/delete distinction on the
  [Dossier](dossier.md) — the button label says "removes its matches" so that's not a surprise.

## Status chips

Each facet shows one of: **inactive**, **not embedded yet**, **edited since last embed** (stale —
your last edit hasn't been scored yet), or **embedded · N chunks**. Without an embedding key
(`VOYAGE_API_KEY`), you can still write and edit facets — they just won't embed or match until one
is configured, and the page says so rather than failing silently.

## Elsewhere

[Matches](matches.md) reads what's written here. [Gaps](gaps.md) compares it against your
[Dossier](dossier.md) fact set to find vocabulary that's on one side but not the other.
