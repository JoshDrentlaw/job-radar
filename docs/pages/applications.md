# Applications — `/applications`

Tracking, never submitting. Every page in this app that touches an application ends at a set of
clipboard-ready fields and a link to the company's own form — nothing here fills anything out for
you.

## Starting one

From a [match](matches.md), **Track an application** opens `/applications/new` pre-populated with
the posting. Pick which [variant](dossier.md#variants--dossiervariants) to send — variants show
their fact count and whether they're already frozen. Submitting **freezes that variant** if it
wasn't already frozen, so the resume you can later re-download is guaranteed to be exactly what
you sent, not whatever the variant has since become.

## The list

Status counts up top, a table of role / company / status / last activity, and a **Show
closed**/**Hide closed** toggle. **Ghosting window** (default 21 days) is set here — an external
sweep marks an application `ghosted` after this many days of silence, and any logged activity
resets that clock.

## Detail page

- **Ready to paste**: read-only copy fields (name, email, phone, location, links, the posting's
  apply URL) sourced from your Identity, plus **Open the company's form** to go fill it out
  yourself.
- **Documents**: links to the frozen variant's resume (PDF/DOCX) and cover letter, if one exists.
- **Where is it now?** records a status change with an optional note. `ghosted` is deliberately
  absent from this list — it's set only by the automated sweep, never by hand, because a
  self-reported "ghosted" would be a guess about the employer rather than an observation about
  silence.
- **Log something** and **Notes** add to an append-only timeline — nothing on it is ever edited or
  deleted; a correction is a new entry. Rule-set transitions (like an automatic ghosting) are
  marked distinctly from things you logged yourself.
- **Delete this record** removes the whole timeline. Recording a status like "withdrawn" instead
  is almost always what you actually want — the panel says so.

## Worth knowing

If an application shows as ghosted, the page is explicit that this reflects a stale row, not an
inference about the employer — logging any activity moves it back out of that state.

## Elsewhere

[Matches](matches.md) is where tracking starts. [Dossier](dossier.md) is where the variant and
documents live.
