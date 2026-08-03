# Job Radar

Finds roles matching demonstrated skills, and removes friction from applying to them. Single user.
Never submits anything.

See the project brief for the full design. This README covers what exists, how to run it, and what
is deliberately not here yet.

## Status

| Milestone              | State                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **M0 — Skeleton**      | Done. Hono, Postgres, migration runner, password auth, sessions, default-deny router.         |
| **M1 — Boards**        | Done. Board CRUD, Greenhouse adapter, snapshot + diff, postings list, coverage ledger.        |
| **M2 — More adapters** | Done. Lever and Ashby adapters, both verified live; parser unit tests for all three adapters. |
| **M3 — Matching**      | Done. Profile facets, chunked Voyage embeddings, match records with cited chunks, tuning.     |
| **M4 — Dossier**       | Done. Fact set, variants with manual rewording, deterministic PDF/DOCX rendering. No LLM.     |
| **M5 — Tailoring**     | Done. Anthropic integration under the fact-id constraint, review flow, cover letters.         |
| M6 — Pipeline + n8n    | Not started                                                                                   |
| M7 — Polish            | Not started                                                                                   |

## Stack

Deno 2.9 (TypeScript, strict) · Hono 4.12 with server-rendered JSX · Postgres 16 + pgvector ·
hand-authored CSS, no framework.

Versions are pinned exactly in `deno.json`. Hono is pinned to 4.12.33 rather than 4.12.34 because
Deno's minimum-dependency-age policy blocks packages published in the last 24 hours — a supply-chain
guard worth keeping rather than disabling.

## Running it

Postgres 16 with the `vector` extension available, then:

```bash
createdb jobradar_dev
cp .env.example .env          # edit DATABASE_URL

deno task migrate up          # apply schema
ADMIN_USERNAME=you ADMIN_PASSWORD='at least twelve chars' deno task seed-admin
deno task start               # http://127.0.0.1:8000
```

`deno task dev` for watch mode. `deno task check` runs typecheck, lint and format check.
`deno task test:unit` runs the parser and domain tests; no database needed.

### Permissions

Every task declares an explicit allowlist — no blanket `-A`. The app runs with network access
limited to Postgres, its own listen port, the three implemented feed hosts
(`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`), and the embedding API
(`api.voyageai.com`), and the Anthropic API (`api.anthropic.com`). **Adding an adapter means adding
its host to the `dev` and `start` tasks**, and until you do, the adapter will fail loudly rather
than succeed quietly. That is the intended behaviour.

`PG*` appears in the env allowlist because postgres.js probes those variables for connection
defaults during option parsing, and `ANTHROPIC_*` because the Anthropic SDK resolves credentials and
log settings from the environment at construction. Deno supports prefix wildcards; everything
outside the listed names and those prefixes is still denied — including in the test tasks, which
declare the same scoped list rather than a blanket `--allow-env`.

## Layout

```
migrations/          numbered plain SQL, up + down, checksum-verified
src/
  domain/discovery/  pure domain — no HTTP, no SQL, no vendor names
  adapters/ats/      board sources + the polite fetcher
  adapters/db/       one repository per aggregate
  adapters/html/     HTML → markdown
  auth/              argon2id, sessions, CSRF, rate limiting, default-deny
  platform/          config, logging, db, migrations, ids, hashing, clock
  web/               Hono app, routes, JSX
static/app.css       the entire stylesheet
test/
  unit/              parser and domain tests, no database required
  fixtures/          live feed payloads, trimmed at tag boundaries — real shapes, not invented ones
```

The three bounded contexts get separate Postgres schema namespaces: `discovery`, `dossier`,
`pipeline`, plus `app` for auth. `dossier` and `pipeline` exist and are empty — they arrive in M4
and M6.

## Decisions worth knowing about

**Provenance is non-nullable.** Every posting row records which adapter version produced it, from
exactly which URL, as of exactly when, and our own content hash. Anything the UI renders can show
its as-of timestamp.

**Asserted and derived data are separated in the schema, not just the UI.** Everything the feed said
lives in `discovery.postings`. Everything computed lives in `discovery.posting_derived`, which
carries the version of the rules that produced it and can be truncated and rebuilt without touching
a single asserted value. In the UI, derived values render in a different hue with a `·derived`
marker.

**Our content hash is authoritative.** Source `updated_at` fields are inconsistently maintained, so
the diff never consults them. Verified in practice: fetching Vercel's board twice in succession
produced 81 postings and then 0 new / 0 changed.

**Disappeared means "no longer listed."** Not filled, not cancelled, not closed. Rows are kept,
`last_seen_at` is recorded, and `last_seen_at` is deliberately _not_ advanced when a posting is
absent.

**One failing board never aborts a run.** Failures are recorded with a reason, a failed snapshot is
written so the ledger can distinguish "we looked and it broke" from "we never looked", and the run
continues.

**No inline styles anywhere**, not just no inline scripts. The CSP sets `style-src 'self'`, so
one-off spacing nudges are named classes instead.

### Every adapter was written against live data

**Greenhouse** — three live boards (Vercel, Anthropic, Figma — 657 postings) surveyed before a line
of parser was written. That established: no pagination even at 400 postings; `content` is
entity-encoded HTML on every posting using exactly the five basic XML entities; `first_published` is
the real publication date; Greenhouse publishes **no** compensation field at all; and the key set
varies slightly between boards. The parser is strict about the fields it uses and tolerant of
everything else.

**Lever** (M2) — two live boards (Spotify, Veeva — 890 postings) plus one live empty board. The
response is a bare JSON array; `[]` is a valid empty board, not an error. The description is split
across three HTML fields (`description`, `lists[]`, `additional`) and all three are reassembled in
the order Lever's own hosted page renders them — the requirements live almost entirely in `lists`.
`workplaceType` is a source-asserted modality on every posting. `salaryRange` appeared on zero of
890 postings, so no parser was written for it — a parser for a shape never observed live would
violate the verify-first rule.

**Ashby** (M2) — four live boards (Linear, Ramp, OpenAI, Modal — 931 postings). Best compensation
coverage of any feed, exactly as the brief predicted. Both documented nesting locations are read
(`summaryComponents` first, `compensationTiers[].components` as fallback), only the Salary component
becomes the structured range, and the source's own `compensationTierSummary` wording is kept
verbatim. `currencyCode` was _absent_ (not null) on 64 components; absent means unstated, not USD.

Parsing the full live payloads end to end — 1,902 postings across all eight boards — produced zero
failures, zero empty descriptions, and a unique content hash per posting.

The HTML→markdown converter covers the measured tag vocabulary —
`li, p, strong, div, h2, ul,
span, a, br, u, h4, h3, em, h1, ol, hr` — plus a conservative tail. M2
taught it one lesson the hard way: Lever wraps `<li>` runs in a `<div>` inside the list, which the
original converter silently dropped. List items are now collected through wrapper elements, and the
Greenhouse adapter version was bumped to `greenhouse/2` because shared-converter changes can alter
its output too.

### M2's domain-model adjustment

The brief predicted M2 would put real pressure on the normalization abstraction. It did, once: Lever
and Ashby both **assert** workplace modality (`workplaceType`) as a source field, while the model
only had the _derived_ `remoteHint` guess. An assertion is not a guess, so postings gained a
source-asserted `workplace_raw` column (verbatim, no CHECK constraint — the source's vocabulary is
not ours to constrain), and the derivation now defers to a recognized assertion rather than
inferring against it (`location/2`). The UI shows the asserted value where one exists and the
derived chip only where the source said nothing.

### How matching works (M3)

**Profile facets** are long-form markdown, authored on `/profile`, each a different angle on the
same experience (`backend`, `data-pipeline`, …). Facets and posting descriptions are both split into
overlapping, paragraph-aligned chunks (`chunk.ts`) and embedded via Voyage AI — postings as
`document`, facets as `query`. Chunk text is stored verbatim so every match can quote the exact
passage that matched; the embedded input for a posting chunk is prefixed with the title, but the
stored quote is untouched.

**Embedding is gated** (§7): a posting is embedded only when no vectors exist for its current
content hash under the current model, so an unchanged posting is never re-billed. The model name is
recorded on every vector and every consumer filters by it — changing `EMBEDDING_MODEL` is the
explicit act that re-embeds and rescores everything. Without `VOYAGE_API_KEY` the app runs fine; the
match pages state what is missing instead of erroring.

**A match** is one row per (posting, facet): the best chunk pair's raw cosine similarity plus which
chunks produced it. Raw floats are stored, but the UI shows only `strong` / `plausible` / `weak`
buckets, computed at read time from thresholds in `app.settings`. `/tuning` is the one place floats
appear: the full score distribution as a histogram, a CSV export, and the threshold form — set the
cut where the data separates, then every view re-buckets instantly. Within a bucket, matches are
ordered by recency, deliberately not by score: nothing implies "apply to this one".

**Gaps**: each posting chunk carries its best score against the whole active profile. The match
detail page quotes chunks whose best support falls in the weak bucket — passages with no strong
counterpart anywhere in the profile — labelled as possibly missing skills _or_ missing vocabulary.

### The dossier (M4)

**The resume is structured data** (§8): a fact set of canonical, true statements (summary lines,
roles, bullets, skills, education, projects), edited on `/dossier`. Facts are **retired, not
deleted** — deleting a fact any variant cites fails loudly (FK RESTRICT) and the UI steers to
retirement, which removes it from pickers while every existing variant still resolves it.

**A variant is a diff against the fact set**: which facts appear, in what order, with what per-fact
rewording. In M4 every rewrite is typed by the user, shown beside the canonical text it replaces —
M5's tailoring will propose into this same shape, and nothing enters a variant unreviewed. Freezing
is one-way; a frozen variant rejects every mutation with an error, not a silent no-op, and
"duplicate" is the path forward. `target_posting_id` is a plain reference, not a foreign key — a
board removal cascades its postings and must never destroy or block a variant.

**Rendering is deterministic by construction** (§15): the PDF writer is a hand-rolled, dependency-
free PDF 1.4 emitter (core Helvetica fonts, real AFM widths for wrapping, no CreationDate, no
document ID) and the DOCX writer builds minimal WordprocessingML over a store-only zip with a fixed
timestamp. Both consume the same `RenderableResume` IR assembled by a pure domain function — the
renderer never sees the database. Tests assert the same variant renders byte-identically twice;
output was additionally validated with independent parsers (zip CRC + XML well-formedness, and an
xref-offset audit of the PDF).

### Tailoring (M5)

**The fabrication constraint is structural, not a prompt.** The tailoring call receives the fact set
and the target posting, and `output_config.format` constrains the reply to
`{factId, rewrittenText, rationale}[]` — the API enforces the shape rather than the prompt asking
for it. Then, in order: **a response citing a `factId` that is not in the set sent rejects the whole
response**, naming every bad id (not the offending row — the whole thing; a model that invents
identifiers was not working from the facts it was given, and its other rows are not trustworthy
either). A retired fact counts as absent, because it was never sent.

**Drift detection** (`drift.ts`) runs on every surviving rewrite and feeds the review queue's
ordering. Two lexical signals, both free: token-overlap similarity catches wholesale rewrites, and
**novel specifics** — numbers and mid-sentence proper nouns present in the rewrite but absent from
its source — catch the dangerous case an embedding check would miss entirely. A fabricated metric
("cutting latency by 40%") is _highly_ similar to its source; it is the new `40%` that gives it
away. Flagging is advisory: every rewrite is reviewed regardless, so this only decides what the
reviewer looks at first.

**Nothing enters a variant unreviewed.** Proposals are stored in their own table and shown
side-by-side with the canonical fact; accepting is the only code path in the application that puts
model-authored text into a variant, and it runs after a human clicks. Rejecting records the decision
and changes nothing. The canonical fact is never touched either way.

**Cover letters** follow the same rule with per-paragraph citations: each paragraph carries the ids
of the facts it rests on, an unknown citation voids the whole letter, and a paragraph citing nothing
is rejected outright. The review page shows each paragraph beside its cited facts verbatim, so
"traceable" is something the reader checks rather than takes on faith. The prompt forbids claiming
enthusiasm or knowledge of the company — there are no facts about how the writer feels, so there is
nothing to write.

**Prompt caching** (§3) puts the fact corpus in a system block with a cache breakpoint and the
posting — different every call — in `messages`, after it. Caching is a prefix match, so that
ordering is the whole trick; a unit test asserts the breakpoint lands on the corpus and never on the
posting.

Without `ANTHROPIC_API_KEY` the app runs fine and the dossier pages say what is unavailable — the
fact set and variants work by hand, which is how M4 proved the data model.

## Open questions from the brief

Flagged rather than guessed.

1. **Embedding provider** — resolved in M3: Voyage AI (`voyage-3.5` by default), Anthropic's
   recommended embeddings partner. The `Embedder` port keeps it swappable; the vector columns are
   dimension-less so a model change is a re-embed, not a schema migration.

2. **Whether disappeared postings surface at all** — currently they are hidden by default with an
   explicit "include postings no longer listed" toggle, and labelled when shown. That is a
   placeholder for a real decision, not the decision.

3. **Whether `remoteHint` derivation earns its place** — largely settled by M2. Lever and Ashby
   assert the modality outright, so on those platforms the derivation simply echoes a fact and the
   string-inference never runs. It still earns its place on Greenhouse, where boards like Vercel
   encode modality in the location string (70 hybrid, 11 remote out of 81) — and still returns
   `unknown` for bare city names, because a fully remote company listing a hub city is
   indistinguishable from an in-office role at this layer. What remains open is only whether
   `unknown` should render at all in list views.

4. **Whether the fact set needs a separate narrative layer for cover letters** — resolved in M5:
   yes. `narrative` is a fact kind, so cover-letter source material carries exactly the same
   traceability guarantee as a resume bullet — same table, same citation rule, same refusal to
   invent. It is simply not resume-shaped, so the resume assembler skips it and warns if one is
   selected into a resume variant. The alternative — a parallel table — would have needed its own
   review flow and its own version of the fabrication constraint, for no gain.

## Not here, on purpose

No auto-apply. No form-filling. No LinkedIn, Indeed or ZipRecruiter — those are declared blind
spots, permanently visible in the coverage panel, not backlog items. No headless browsers. No CSS
framework. No user roles.
