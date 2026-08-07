# Dossier — `/dossier`

The resume, as data instead of a document. Four screens make up one workflow: a **fact set** you
write by hand, **variants** that select and reorder facts for a specific posting, **tailoring**
proposals a model can proposes but never applies on its own, and **cover letters** built the same
way. The path through them is: facts → a variant → (optionally) proposed rewrites → a reviewed,
frozen variant → (optionally) a cover letter.

## The fact set — `/dossier`

Every canonical, true statement about you: summary lines, roles, bullets, skills, education,
projects, plus **narrative** facts, which are cover-letter source material that never renders on
a resume. **No model writes to this page, in any milestone** — new truth enters here by hand,
always.

- **Add a fact**: kind, an optional parent (bullets need a parent role or project or they render
  nowhere — an "orphan bullets" section flags this if it happens), the canonical text, organization,
  comma-separated tags, and start/end dates (month precision; blank end means present).
- **Retire**, don't delete, a fact you no longer want offered to new variants — retiring hides it
  from pickers while every variant that already cites it keeps rendering it correctly. **Delete**
  is blocked outright if any variant cites the fact; there's no force-delete.
- **Identity** (name, email, phone, location, links) is edited on this same page but isn't a fact
  — it's just the header block every rendered resume and cover letter uses.

## Variants — `/dossier/variants`

A variant is a diff against the fact set: which facts, in what order, with what per-fact
rewording. Nothing is ever stored as a rendered document — PDF and DOCX are generated on demand
from the current variant state, and two renders of the same variant are byte-identical.

- **New variant**: a name and an optional target posting.
- On the variant's page: reorder included facts, remove them, add from everything not yet
  included, and reword any entry by hand — the same `rewrittenText` field a tailoring proposal
  writes into, so manual and AI-accepted rewrites are indistinguishable once saved.
- **Freeze** is one-way. A frozen variant refuses every further mutation (with an explicit error,
  not a silent no-op) — **Duplicate** is the way forward from there. Starting an
  [application](applications.md) freezes its variant automatically, so what you sent never drifts
  from what the app remembers sending.
- Assembly warnings catch a bullet with no selected parent and a narrative fact selected into a
  resume (it's cover-letter-only and will be skipped).

## Tailoring — `/dossier/runs/:runId`

**Propose rewrites** (on an unfrozen variant with a target posting and an `ANTHROPIC_API_KEY`
configured) sends your active facts and the posting to the model under a hard constraint: it may
only reword facts it was given, citing each by id, and it may not introduce a number, employer,
technology, or claim that wasn't already in the source fact. **A response citing an id that
doesn't exist in your fact set is rejected in full** — not just the bad row, the whole run — because
a model that invents an identifier isn't working from the facts it was given.

- Each proposal shows the canonical text beside the proposed rewrite, a rationale, and a drift
  check: **no drift detected**, or **needs a closer look** with the specific novel terms the model
  introduced that weren't in the source — that's where a fabricated specific would show up.
- **Accept** writes the proposed wording into the variant (adding the fact to it if it wasn't
  already included). **Reject** just records the decision. The canonical fact is never touched
  either way, and nothing reaches a variant without this explicit click.

## Cover letters — `/dossier/letters/:id`

Generated the same way, with per-paragraph citations instead of per-fact ones: each paragraph
lists the exact facts it rests on, and a paragraph citing nothing is flagged as an error, not a
warning — delete it rather than leave it. Edit any paragraph's wording by hand (your own wording
always wins over the model's); **accept** requires actually reading each paragraph against its
citations first, which is why the button itself is the attestation: *"I have read every paragraph
against its citations — accept."* **Plain text** exports the letter with a signature block built
from your Identity.

## Elsewhere

[Applications](applications.md) freezes a variant the moment you start tracking one.
[Gaps](gaps.md) compares this fact set against your [Profile](profile.md).
