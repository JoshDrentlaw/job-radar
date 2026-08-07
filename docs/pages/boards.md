# Boards — `/boards`

The board registry is the denominator for every count the app shows — coverage, postings,
matches, all of it are measured against "boards we're actually reading." A board that's annoying
to add is a board that doesn't get added, which is why this page also hosts **Find a board**, a
lookup that turns a company name into a working registration instead of making you guess a slug.

## Adding a board directly

If you already know the platform and slug: **Platform** (Greenhouse, Lever, or Ashby have working
adapters; the other four in the dropdown are listed but disabled — "adapter not built yet"),
**Board slug**, **Company name**, optional **Tags** and **Notes**. Platform + slug is the identity
— submitting the same pair again updates the details in place rather than creating a duplicate,
and fetch history is untouched.

## Finding a board by name

**Find a board** takes a company name (or a pasted careers-page URL, which skips guessing
entirely) and probes Greenhouse, Lever, and Ashby for a match. Results split into hits — shown
with a live posting count and sample titles, because the preview is read through the same adapter
code that will collect the board for real — and misses, collapsed under "What was asked and
answered no." A hit is cached for a day, a miss for a week; "Check again" bypasses the cache. Every
probe, hit or miss, is recorded in a running catalogue at the bottom of the page, so "Spotify
isn't on Greenhouse" only has to be discovered once. One click on a result adds it with platform,
slug, and — on a Greenhouse hit — the company name, all pre-filled.

## Managing a registered board

Each row: **Fetch now** (fetches just that board), an **Activate/Deactivate** toggle (deactivating
stops fetching but keeps history — the honest way to pause a board), and a link into the board's
detail page. Detail shows fetch history and a **Delete** action that removes the board *and* its
postings — the page says so plainly, because deactivating is almost always what you actually want
instead.

## Worth knowing

- Three consecutive fetch failures surface a warning on the board's detail page before it becomes
  a Coverage-page problem.
- Bulk paste (resolving a list of company names in one pass) was scoped out deliberately — see the
  README for why.

## Elsewhere

[Coverage](coverage.md) · [Postings](postings.md)
