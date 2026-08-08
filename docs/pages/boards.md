# Boards — `/boards`

The board registry is the denominator for every count the app shows — coverage, postings, matches,
all of it are measured against "boards we're actually reading." A board that's annoying to add is a
board that doesn't get added, which is why this page also hosts **Find a board**, a lookup that
turns a company name into a working registration instead of making you guess a slug.

Two tabs: **Boards**, the registry itself, and **Coverage**, the honesty page below.

## Adding a board directly

If you already know the platform and slug: **Platform** (Greenhouse, Lever, or Ashby have working
adapters; the other four in the dropdown are listed but disabled — "adapter not built yet"), **Board
slug**, **Company name**, optional **Tags** and **Notes**. Platform + slug is the identity —
submitting the same pair again updates the details in place rather than creating a duplicate, and
fetch history is untouched.

## Finding a board by name

**Find a board** takes a company name (or a pasted careers-page URL, which skips guessing entirely)
and probes Greenhouse, Lever, and Ashby for a match. Results split into hits — shown with a live
posting count and sample titles, because the preview is read through the same adapter code that will
collect the board for real — and misses, collapsed under "What was asked and answered no." A hit is
cached for a day, a miss for a week; "Check again" bypasses the cache. Every probe, hit or miss, is
recorded in a running catalogue at the bottom of the page, so "Spotify isn't on Greenhouse" only has
to be discovered once. One click on a result adds it with platform, slug, and — on a Greenhouse hit
— the company name, all pre-filled.

## Asking about a whole list

The lookup above assumes you know who to ask about. Mostly you won't — these platforms host
venture-backed and mid-market companies, so the names you can think of unprompted (Walmart,
McDonald's) are on Workday or Taleo and will never appear, while the ones that would hit are
companies you've never heard of. Names realistically arrive a few hundred at a time, off a VC
portfolio page or a spreadsheet column.

**Ask about a list** takes one name per line. Pasting queues them and nothing more — no network, so
a three-hundred-name list submits instantly. The asking is done by the `prospect` job on whatever
schedule you've set, one request per second per platform, in bounded slices. Blank lines, `#`
comments, trailing commas and wrapping quotes are all stripped, so a column pasted straight out of a
spreadsheet works as-is. **Source** is optional free text ("a16z portfolio", "YC W24") and exists so
you can see which harvest is actually yielding boards and stop feeding the ones that aren't.

Re-pasting an overlapping list is normal and cheap: names already queued are skipped, and the
confirmation says how many were new versus already there. Names already asked about are answered
from the catalogue rather than re-probed.

Below the form: how many are **waiting**, how many have been **asked**, and — only when it happens —
how many **gave up** after three attempts. **Ask about the next 5** drains a few by hand, right
there, in about twenty seconds — it exists so the queue is usable before you've pointed a scheduler
at `/api/jobs/prospect`, and the notice tells you how many are left. A long list is better left to
the job. That last count is separate on purpose; a queue that has quietly stopped moving must not
look like an empty one. "Clear the N already asked" empties the queue only. Every answer stays in
the catalogue, so clearing costs nothing.

Found boards show up in the catalogue at the bottom of the page like any other hit, and registering
one is still a click you make.

## Managing a registered board

Each row: **Fetch now** (fetches just that board), an **Activate/Deactivate** toggle (deactivating
stops fetching but keeps history — the honest way to pause a board), and a link into the board's
detail page. Detail shows fetch history and a **Delete** action that removes the board _and_ its
postings — the page says so plainly, because deactivating is almost always what you actually want
instead.

## Coverage

`/coverage` — the honesty page. Every count anywhere in this app — postings, matches, gaps — is
bounded by "boards currently configured and readable," and this is where that denominator is made
explicit rather than left implied.

### Reading it

- **Most recent run**: boards configured vs. fetched vs. failed, postings seen / new / changed /
  no-longer-listed.
- **Active boards not currently readable** — only appears when at least one active board is actually
  failing, with its consecutive-failure count and the reason.
- **Declared blind spots**: a static, permanent list (LinkedIn, Indeed, ZipRecruiter — sites this
  app deliberately doesn't read) shown here on purpose, not filed away as a backlog item.
- **Run history**: up to 25 past runs, each linking to a board-by-board breakdown.

### Run detail

Distinguishes three different ways a board can be missing from a run's numbers: it **failed**
outright (shown with a reason), it's **currently stale** (surfaced on the main tab), or it simply
has **no row at all** for an older run that only kept its totals — called out explicitly as a gap in
the record itself, not a board that returned nothing.

## Worth knowing

- Three consecutive fetch failures surface a warning on the board's detail page before it becomes a
  Coverage-tab problem.
- One failing board never aborts a run — the rest still get fetched, and the failure is recorded
  with a reason rather than silently dropping that board's contribution to the totals.
- A found board is never registered for you, including by the queue. The registry is the denominator
  for every count in the app, so what joins it stays a decision you made.

## Elsewhere

[Matches](matches.md) · [All postings](matches.md#all-postings)
