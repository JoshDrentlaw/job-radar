# Dashboard — `/`

The one page that knows about everything else. It opens with **"waiting for you"** — a prioritized
list built by checking, in order: unreviewed tailoring proposals (a model wrote them and nobody has
looked), applications still drafting, applications going quiet _before_ the ghosting window closes
(not after — the point is to catch it while there's still time to act), ghosted applications, and
boards that have stopped fetching. A panel with nothing in it doesn't render, so an empty dashboard
on a quiet day is genuinely empty, not a wall of "0 items" cards.

## Using it

- **Collect now** (top of page) runs a fetch across every active board immediately, without waiting
  for the next scheduled n8n run.
- The matches summary shows strong / plausible / weak counts, de-duplicated per posting — a posting
  matching two facets still counts once. If no embedding key is configured (`VOYAGE_API_KEY`), this
  panel explains that instead of showing zeros.
- **Boards needing attention** only appears when at least one board is actually failing.
- **Most recently seen** is the 10 newest postings across every board, each linking to its detail
  page.

## Worth knowing

- The ghosting window that decides "going quiet" defaults to 21 days and is configurable on
  [Applications](applications.md) — the dashboard reads whatever is currently set.
- "Waiting for you" items link straight to where the action happens: a pending proposal links into
  the tailoring review queue, a quiet application links to its detail page, a failing board links to
  [Coverage](coverage.md).

## Elsewhere

[Matches](matches.md) · [Coverage](coverage.md) · [Postings](postings.md)
