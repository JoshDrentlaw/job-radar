# Coverage — `/coverage`

The honesty page. Every count anywhere in this app — postings, matches, gaps — is bounded by
"boards currently configured and readable," and this is where that denominator is made explicit
rather than left implied.

## Reading it

- **Most recent run**: boards configured vs. fetched vs. failed, postings seen / new / changed /
  no-longer-listed.
- **Active boards not currently readable** — only appears when at least one active board is
  actually failing, with its consecutive-failure count and the reason.
- **Declared blind spots**: a static, permanent list (LinkedIn, Indeed, ZipRecruiter — sites this
  app deliberately doesn't read) shown here on purpose, not filed away as a backlog item.
- **Run history**: up to 25 past runs, each linking to a board-by-board breakdown.

## Run detail

Distinguishes three different ways a board can be missing from a run's numbers: it **failed**
outright (shown with a reason), it's **currently stale** (surfaced on the main page), or it simply
has **no row at all** for an older run that only kept its totals — called out explicitly as a gap
in the record itself, not a board that returned nothing.

## Worth knowing

One failing board never aborts a run — the rest still get fetched, and the failure is recorded
with a reason rather than silently dropping that board's contribution to the totals.

## Elsewhere

Every board name here links to [its registry entry](boards.md).
