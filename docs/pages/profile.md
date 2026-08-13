# Profile — `/profile`

The input side of matching. A **facet** is one angle on your experience — `backend`,
`data-pipeline`, `infra` — written as long-form markdown. This is not a job-category picker: two
facets that would match the same postings aren't earning their keep as separate facets, and the
page's own copy warns against splitting them that finely.

Two tabs: **Profile**, where facets are written, and **Gaps**, a read-only report on vocabulary that
shows up in postings but not here.

## Something to write about

Figuring out what to write is the hard part, so the page opens with up to two prompts pulled from
data it already has — no new writing required to get one:

- **A fact no facet reflects yet** — something already in your [Dossier](dossier.md) that shares no
  word with your profile, other than words that show up in most of your facets already (your own
  habits of phrase — "built", "team" — don't count as covering a fact just because they're common).
  Quoted back to you directly, since it's a real sentence you wrote.
- **A term postings keep using that appears nowhere** — the same "not written anywhere" situation
  the [Gaps](#gaps) tab reports, surfaced as a question instead of a table row: have you actually
  done that, or just never called it this?

Both are picked at random and by word overlap, not meaning, so treat them as a nudge rather than a
verdict — **Another prompt** reloads the page for a different pick. The panel is absent entirely
once there's nothing left to suggest.

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

## Gaps

`/gaps` — a read-only report, and its own headline warning: **a gap cannot tell a missing skill from
a missing word.** "Terraform" showing up in nineteen postings and nowhere in your writing might mean
you've never used it, or that you called it "infrastructure as code" and never named the tool. Those
need opposite responses, and nothing on this tab can tell them apart — so it counts and refuses to
conclude, on purpose.

### Three situations, in the order shown

1. **Not written anywhere** — the term appears in neither your Profile facets nor your
   [Dossier](dossier.md) facts.
2. **In your profile, not in your facts** — matching can find these roles, but no resume can cite
   them, because nothing in the fact set backs the claim.
3. **In your facts, not in your profile** — the resume could claim it, but matching can't see it, so
   those roles are being scored without the evidence that would have surfaced them.

Each term links to example postings it came from, so you can judge in context rather than from a
bare word.

### Worth knowing

This is pure counting — document frequency of terms and phrases across postings, no model and no
embeddings involved, specifically so it stays checkable. A term needs to show up in a minimum number
of postings (adjustable via `?min=`) before it counts as "recurring" rather than noise.

## Elsewhere

[Matches](matches.md) reads what's written here. The Gaps tab compares it against your
[Dossier](dossier.md) fact set to find vocabulary that's on one side but not the other.
