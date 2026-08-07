# Matches — `/matches`

Postings scored against your [profile](profile.md) by semantic similarity, bucketed into **Strong**,
**Plausible**, and **Weak**. Within a bucket, matches are ordered by recency, not by score — score
decides which bucket a posting lands in, not which one you look at first. Nothing here implies
"apply to this one."

## Using it

- **Refresh matches** embeds anything new and scores everything stale. It's disabled outright if no
  embedding key (`VOYAGE_API_KEY`) is configured — the page says so instead of pretending the button
  works. After refreshing, a notice reports what got embedded and scored, and flags it if there's
  still a backlog worth another refresh.
- **Search** filters by title, company, or location. A **Facet** dropdown appears only if you have
  more than one active profile facet — pick one to see how postings score against just that angle of
  your experience.
- The **Weak** bucket is collapsed by default but never hidden — the floor of the funnel is meant to
  stay inspectable, just not the first thing you read.

## Match detail — "why this surfaced"

Each match cites the exact chunk of the posting that matched, and which facet it matched against. A
separate **Possible gaps** section lists passages of the posting with no strong support anywhere in
your profile — these are candidate missing skills _or_ missing vocabulary; the page can't tell which
(see [Gaps](gaps.md) for the corpus-wide version of this same honest limit). From here, **Track an
application** hands the posting straight to [Applications](applications.md).

## Worth knowing

- Bucket thresholds live on [Tuning](tuning.md) — this page just applies whatever's currently set.
- A posting not yet embedded doesn't appear in any bucket; the page warns you when there's an
  embedding backlog so a "no matches" reading doesn't get mistaken for "no fit."

## Elsewhere

[Tuning](tuning.md) · [Gaps](gaps.md) · [Applications](applications.md) · [Postings](postings.md)
