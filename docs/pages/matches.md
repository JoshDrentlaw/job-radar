# Matches — `/matches`

Postings scored against your [profile](profile.md) by semantic similarity, bucketed into **Strong**,
**Plausible**, and **Weak**. Within a bucket, matches are ordered by recency, not by score — score
decides which bucket a posting lands in, not which one you look at first. Nothing here implies
"apply to this one."

Three tabs share this page: **Matches** (scored, bucketed), **All postings** (the raw feed), and
**Tuning** (where the bucket cut points live).

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
(see [Gaps](profile.md#gaps) for the corpus-wide version of this same honest limit). From here,
**Track an application** hands the posting straight to [Applications](applications.md).

## All postings

`/postings` — every job pulled from every registered board, unfiltered by anything the app has an
opinion about. This is the raw feed — for "which of these fit me," the Matches tab is the semantic
version; this tab's search is deliberately plain keyword matching over title and description, not
semantic skill matching.

### Using it

- **Search** matches on keywords like `postgres` or `typescript`.
- **Board** narrows to one company.
- **Include postings no longer listed** is off by default. "No longer listed" means exactly that —
  not filled, not cancelled, not closed, just absent from the feed the last time it was fetched. The
  app doesn't know which of those it is, so it doesn't guess.
- Results page 25 at a time.

### Posting detail

Fields are visually distinguished as **asserted** (stated directly by the source feed) versus
**derived** (computed by this app — location normalization, work-arrangement inference). A legend at
the top of the page explains the distinction the first time you see it. Compensation, location, and
work-arrangement fall back to explicit "not stated" / "not published by this source" chips rather
than blank space. **Open the posting** links out to the original apply page — this app never submits
anything on your behalf.

## Tuning

`/tuning` — the one place raw similarity scores are shown as numbers instead of the strong /
plausible / weak buckets used everywhere else. A histogram of every scored (posting, facet) pair,
colored by which bucket each bin currently falls in.

### Using it

- **Strong at or above** and **Plausible at or above** are the two cut points; anything below
  plausible is weak. Saving them re-buckets every existing score immediately — it doesn't re-score
  anything, so this is instant even with a large corpus.
- **Export CSV** downloads the full score list
  (`posting_id, title, company, facet, score,
  scored_at`) if you want to look at the distribution
  outside the app.
- With nothing scored yet, the histogram and metrics are simply absent rather than showing empty
  charts.

Set the cut where the data actually separates, using the histogram, rather than picking round
numbers — that's the entire reason this tab shows floats when nothing else in the app does.

## Worth knowing

- Bucket thresholds live on the Tuning tab — the Matches tab just applies whatever's currently set.
- A posting not yet embedded doesn't appear in any bucket; the page warns you when there's an
  embedding backlog so a "no matches" reading doesn't get mistaken for "no fit."

## Elsewhere

[Boards](boards.md) · [Coverage](boards.md#coverage) · [Profile](profile.md) ·
[Gaps](profile.md#gaps) · [Applications](applications.md)
