# Tuning — `/tuning`

The one place raw similarity scores are shown as numbers instead of the strong / plausible / weak
buckets used everywhere else. A histogram of every scored (posting, facet) pair, colored by which
bucket each bin currently falls in.

## Using it

- **Strong at or above** and **Plausible at or above** are the two cut points; anything below
  plausible is weak. Saving them re-buckets every existing score immediately — it doesn't re-score
  anything, so this is instant even with a large corpus.
- **Export CSV** downloads the full score list
  (`posting_id, title, company, facet, score,
  scored_at`) if you want to look at the distribution
  outside the app.
- With nothing scored yet, the histogram and metrics are simply absent rather than showing empty
  charts.

## Worth knowing

Set the cut where the data actually separates, using the histogram, rather than picking round
numbers — that's the entire reason this page shows floats when nothing else in the app does.

## Elsewhere

[Matches](matches.md) applies whatever thresholds are set here.
