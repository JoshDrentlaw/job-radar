# Postings — `/postings`

Every job pulled from every registered board, unfiltered by anything the app has an opinion
about. This is the raw feed — for "which of these fit me," see [Matches](matches.md) instead;
this page's search is deliberately plain keyword matching over title and description, not the
semantic skill matching that page does.

## Using it

- **Search** matches on keywords like `postgres` or `typescript`.
- **Board** narrows to one company.
- **Include postings no longer listed** is off by default. "No longer listed" means exactly that
  — not filled, not cancelled, not closed, just absent from the feed the last time it was fetched.
  The app doesn't know which of those it is, so it doesn't guess.
- Results page 25 at a time.

## Posting detail

Fields are visually distinguished as **asserted** (stated directly by the source feed) versus
**derived** (computed by this app — location normalization, work-arrangement inference). A legend
at the top of the page explains the distinction the first time you see it. Compensation, location,
and work-arrangement fall back to explicit "not stated" / "not published by this source" chips
rather than blank space. **Open the posting** links out to the original apply page — this app
never submits anything on your behalf.

## Elsewhere

[Matches](matches.md) · [Coverage](coverage.md) — if a posting you expected isn't here, that's the
page that explains why.
