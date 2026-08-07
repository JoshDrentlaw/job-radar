# Job Radar

Finds roles matching demonstrated skills, and removes friction from applying to them. Single user.
Never submits anything.

Postings are collected from company ATS feeds, scored against a written skill profile by semantic
similarity, and turned into a resume built from a fact set — never a document edited freehand. Every
generated word traces back to something the user actually wrote or a fact they approved; nothing is
invented, and nothing is ever submitted anywhere without a human clicking "open the company's form"
and doing it themselves.

## Ethos: friction is a bug

Nearly every milestone below started from finding a place the app was making the user do something
tedious that the app itself was better positioned to do. Guessing an ATS slug became
[a lookup that probes and pre-fills it](docs/pages/boards.md). Hunting the dashboard for what needed
attention became a single ["waiting for you" list](docs/pages/dashboard.md), ordered by urgency.
Manually noticing an application had gone quiet became
[an automated sweep](docs/pages/applications.md) that only resets when you log real activity.
Copying contact details into a form became
[read-only, copy-ready fields](docs/pages/applications.md#detail-page) sourced from one place. The
constant is the same: find the copy-paste, the guesswork, the thing you'd do the same way every time
— and have the app do it instead, without ever crossing the line into inventing something that isn't
true (see [Dossier](docs/pages/dossier.md) for how that line is enforced structurally, not just by
asking a model nicely).

This README covers what exists, how to run it, and what is deliberately not here yet. Each page also
has its own short tutorial — start there for how to actually use the thing.

## Page tutorials

| Page                                       | What it's for                                                         |
| ------------------------------------------ | --------------------------------------------------------------------- |
| [Dashboard](docs/pages/dashboard.md)       | What's waiting for you, across every other page                       |
| [Boards](docs/pages/boards.md)             | The ATS registry — add a board by name, not by guessed slug           |
| [Postings](docs/pages/postings.md)         | Every job pulled from every registered board                          |
| [Matches](docs/pages/matches.md)           | Postings scored against your profile, bucketed strong/plausible/weak  |
| [Profile](docs/pages/profile.md)           | The skill profile matching reads from                                 |
| [Dossier](docs/pages/dossier.md)           | The fact set, resume variants, AI-proposed rewrites, cover letters    |
| [Tuning](docs/pages/tuning.md)             | Where the strong/plausible/weak cut points are set                    |
| [Gaps](docs/pages/gaps.md)                 | Vocabulary that shows up in postings but not in your profile or facts |
| [Applications](docs/pages/applications.md) | Tracking — never submitting                                           |
| [Coverage](docs/pages/coverage.md)         | The honesty page: what's actually being read, and what isn't          |
| [Account](docs/pages/account.md)           | Password and passkeys                                                 |
| [Automation](docs/pages/automation.md)     | Bearer tokens for the n8n-driven job routes                           |

## Status

| Milestone                 | State                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **M0 — Skeleton**         | Done. Hono, Postgres, migration runner, password auth, sessions, default-deny router.         |
| **M1 — Boards**           | Done. Board CRUD, Greenhouse adapter, snapshot + diff, postings list, coverage ledger.        |
| **M2 — More adapters**    | Done. Lever and Ashby adapters, both verified live; parser unit tests for all three adapters. |
| **M3 — Matching**         | Done. Profile facets, chunked Voyage embeddings, match records with cited chunks, tuning.     |
| **M4 — Dossier**          | Done. Fact set, variants with manual rewording, deterministic PDF/DOCX rendering. No LLM.     |
| **M5 — Tailoring**        | Done. Anthropic integration under the fact-id constraint, review flow, cover letters.         |
| **M6 — Pipeline + n8n**   | Done. Applications with an append-only timeline, bearer-authenticated job routes, ghosting.   |
| **M7 — Polish**           | Done. Passkeys, vocabulary-gap detection, a dashboard that knows what the app now does.       |
| **M8 — Interface**        | Done. A field standard, rendered markdown, a profile page that scales, a mobile pass.         |
| **M9 — Board lookup**     | Done. Name a company, get its board. Slug guessing, cheap probes, an accumulating catalogue.  |
| **M11 — Seed a resume**   | Done. Paste a resume, review extracted facts, add only what you check.                        |
| **M12 — Writing prompts** | Done. Two nudges on Profile, pulled from the Gaps machinery, not new logic.                   |

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

**Deploying to a droplet:** [`docs/deploy.md`](docs/deploy.md).

CI runs the same `check` and `test:unit` on every push, plus one thing that cannot be checked
without a database: that all ten migrations apply to an empty Postgres 16 with pgvector, and that
applying them twice is a no-op. `deno install --frozen` gates the lockfile, so a dependency that is
merely _believed_ pinned fails the build.

Passkeys need a secure context, which means HTTPS in production or `localhost` in development. The
account page says so plainly when the configured base URL is neither.

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
  domain/            pure domain per context — no HTTP, no SQL, no vendor names
    discovery/         boards, snapshots, matching, coverage
    dossier/           facts, variants, resume assembly, tailoring, drift
    pipeline/          applications, the status vocabulary, the ghosting rule
  adapters/ats/      board sources + the polite fetcher
  adapters/db/       one repository per aggregate
  adapters/html/     HTML → markdown
  adapters/llm/      Anthropic client behind the LlmClient port
  adapters/render/   deterministic PDF and DOCX writers
  auth/              argon2id, sessions, CSRF, rate limiting, default-deny
    webauthn/          CBOR, COSE keys, ceremony verification
  platform/          config, logging, db, migrations, ids, hashing, clock
  web/               Hono app, routes, JSX
static/app.css       the entire stylesheet
static/webauthn.js   the only client-side script, and only because WebAuthn needs one
test/
  unit/              parser and domain tests, no database required
  fixtures/          live feed payloads and real WebAuthn ceremonies — real shapes, not invented ones
  tools/             the Chromium script that regenerates the WebAuthn fixtures
```

The three bounded contexts get separate Postgres schema namespaces: `discovery`, `dossier`,
`pipeline`, plus `app` for auth. References across a context seam are plain ids, never foreign keys:
an application must outlive the posting it was sent to.

## Decisions worth knowing about

The `§` references below point to sections of the original design brief that shaped each milestone.
The brief itself isn't in this repo — treat them as citations to a private spec, not broken links.

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

### Pipeline and the n8n boundary (M6)

**The app owns the work; n8n owns the schedule and the delivery.** Five routes under `/api/jobs/` do
the work — `collect`, `embed`, `match`, `sweep`, and a read-only `digest` — and none of them knows
what a notification is. Everything they need to decide anything is in the JSON they return.

**The status code is the contract.** 200 clean, **207 partial**, 500 the run itself failed, so n8n
branches on the response rather than parsing prose. A collection run where one board 503s is a 207
that _names the board_, because "1 board failed" is not something you can act on; a run where every
board failed is a 500, because nothing partially worked. An embed run with a backlog remaining is
also a 207 — call again rather than waiting a full cycle. Unit tests drive the real app through each
of these.

**The job routes authenticate with a bearer token, not the session cookie**, and are mounted
_before_ the session middleware, so a session cookie grants nothing there and a bearer token grants
nothing anywhere else. Both directions are tested. CSRF does not apply and is not needed: it exists
because browsers attach cookies automatically, and nothing under `/api` reads one. §11 says secrets
live in the environment and never the database, and also that this token is rotatable from the UI;
both hold, because only a SHA-256 of the token is stored — exactly as sessions store a hash of the
cookie. The plaintext is shown once, at creation, and never again. Minting the replacement before
revoking the old one leaves no gap.

**`ghosted` is an honest name for a stale row, not an inference about the employer.** The sweep
marks an application ghosted after a configurable window of silence, records the transition as
`source: 'rule'` on the timeline, and — deliberately — does not touch `last_activity_at`, so the
sweep never resets the clock it reads. A rule-set status reads differently from an observation when
you come back to the timeline, and the UI keeps `ghosted` out of the manual status form for the same
reason.

**The timeline is append-only.** Events are never updated or deleted; a correction is another row.
The application itself denormalizes the posting title, company and apply URL at creation, so the
record still reads correctly after the listing is gone.

**Coverage got a per-board run detail view.** The run row said "9 of 11 boards, 240 postings"; the
detail says which two boards are missing from that number, why, and which board the new postings
actually came from. Failures sort first. The breakdown is written in the same transaction as the
totals — a total whose denominator was lost is the artifact §10 exists to prevent.

**Applying is still a deliberate human act.** The application detail page is a set of
clipboard-ready fields and links; nothing posts anything anywhere.

### Passkeys (M7)

**A second way in, not a replacement.** The password stays, because a single-user application whose
only credential lives on one device is one lost phone away from being locked out of itself.

**The verifier is written here rather than pulled in**, and that is a real trade worth stating.
`@simplewebauthn/server` brings roughly twenty packages — asn1js, x509, tsyringe, reflect-metadata —
almost entirely to evaluate _attestation_, the question "is this authenticator model one I trust?"
that an enterprise asks about hardware it did not buy. There is one user here enrolling their own
devices from inside an already-authenticated session; the answer is yes every time, so the
registration options ask for `attestation: "none"` and nothing evaluates it. What remains is CBOR
parsing and ceremony checks, with WebCrypto doing the actual cryptography — no hand-rolled
primitives. The cost is that a passkey bug is now ours; the mitigation is below.

The pieces: a CBOR decoder covering exactly the canonical subset CTAP2 mandates, with indefinite
lengths, tags, duplicate keys and trailing bytes all refused rather than tolerated; COSE→JWK import
for ES256 and RS256, with every other algorithm refused **by name** rather than silently attempted;
and the DER→raw ECDSA signature conversion that quietly breaks naive implementations. Every check in
the ceremony is annotated with the hole it closes — origin, rpId hash, ceremony type, user presence,
user verification, signature, and the use counter that detects a cloned authenticator.

**User verification is required on both ceremonies.** A passkey here signs you in on its own, so a
device that proves only presence ("someone touched this key") and not identity is not enough.
Credentials are **discoverable**, so signing in needs no username first — with one user and no
registration route, asking "who are you?" before "prove it" would be theatre.

**Challenges are consumed in a single atomic `UPDATE`.** A read followed by a write is a race that
permits a replay, which is the one thing a challenge exists to prevent. Verified against a real
database: single-use, purpose-scoped, expiry enforced in the same statement, and exactly one winner
in a race of eight concurrent consumers.

**Verified, not assumed.** The fixtures in `test/fixtures/webauthn/` are real payloads from
Chromium's virtual authenticator over CDP, including a deliberately UV-less one, and 23 unit tests
run against them. The whole flow was then driven end-to-end in a real browser against a real
Postgres — register, sign out, sign in with the passkey alone, replay refused, remove, refused again
— and with JavaScript disabled the button never appears and the password form still works.

`static/webauthn.js` is the only client-side script in the application, and it exists only because
`navigator.credentials` is a browser API that no amount of server rendering reaches. The passkey
controls ship hidden in the markup and that file is what reveals them.

### Vocabulary gaps (M7)

M3 answers this per posting: which passages of _this_ job have no strong support in the profile.
This answers it across the corpus — which terms keep appearing in the roles being matched and appear
nowhere in what you have written about yourself.

**The honest limit is the headline, not a footnote: a gap cannot tell a missing skill from a missing
word.** "Terraform" in nineteen postings and nowhere in your profile might mean you have never used
it, or that you wrote "infrastructure as code" and never named the tool. Those need opposite
responses, and nothing on the page can distinguish them, so it counts and refuses to conclude —
which also keeps it from reading as an invitation to pad a resume (§8).

Three situations, separated because they need different answers: absent from both corpora; in the
profile but not the fact set (matching finds these roles, no resume can cite them); in the fact set
but not the profile (the resume can claim it, matching cannot see it, so those roles are being
scored without the evidence that would have matched them).

No model and no embeddings — counting, which is checkable, so every term carries the postings it
came from. Document frequency, not term frequency. Phrases as well as words, with a segment rule so
no phrase is ever invented across a sentence break or the join between a title and its body
("platform kubernetes" is not a term anybody wrote), and a phrase subsumes its parts when it covers
the same postings.

### The friction six milestones surfaced (M7)

**The dashboard had never been revisited.** It knew about boards and postings and nothing about
matching, tailoring or applications — most of what the application now does. It now opens with
"waiting for you": unreviewed proposals first (a model wrote them and nobody has looked), then
applications still drafting, then ones going quiet _before_ the window closes rather than after,
then boards that cannot be read. Panels with nothing in them do not render.

**The ghosting window was a knob with no handle** — read by the sweep, settable from nowhere. It now
lives on the page it governs.

**Matches had no search** while `/postings` had one from M1, which made a long strong bucket hard to
work through.

### The interface pass (M8)

**A form field is now one thing, not four loose elements.** `.field-row` used to be a grid of bare
`<div>`s bottom-aligned to each other, so a field carrying a hint was taller than one that did not
and the row settled into masonry — three inputs in a row sitting at three different heights. Row
alignment cannot fix that, because a label, a control and a hint are three bands that have to line
up independently. `Field` emits exactly those three bands and the CSS places them on a **subgrid**,
so the bands are shared across the row: every label on one line, every control on the next, hints
hanging below without moving anything above them. A label that wraps now moves every control in the
row together instead of only its own. There is a `@supports not` fallback to top alignment, which is
what the layout should have been doing all along.

**Markdown renders.** Three kinds of text in this application are markdown — profile facets, posting
descriptions converted from the feed's HTML, and application notes — and all three were displayed as
their own source. `src/web/markdown.tsx` is a small hand-written renderer whose important property
is structural rather than typographic: **it produces a JSX tree, never an HTML string**. There is no
`dangerouslySetInnerHTML` anywhere in the application and no way to add one through it, so every
character still leaves through hono's escaping. A facet containing `<script>` renders the seven
characters `<script>`. Raw HTML in the source is deliberately not passed through, link destinations
are restricted to `http`, `https`, `mailto` and same-origin paths — a `javascript:` href renders its
label as plain text — and images become links, because the CSP allows `img-src 'self' data:` and a
remote image was never going to load. 18 unit tests, most of them about the refusals.

**The profile page stopped punishing you for using it.** Every facet was an open editor, so the page
was a wall of textareas and adding a facet pushed the "new facet" form further down — the form to
add the next one moved every time you added one. The add form is now a disclosure pinned to the top,
each facet is a card showing its rendered text with the editor folded away, and an index of anchors
appears once there is more than one.

**The mobile pass.** Every page is a single column already, so this was four specific things: a
twelve-item nav that wrapped into four lines is now one horizontally scrollable strip (no disclosure
to open, and no JavaScript, which this application does not have); tables get natural column widths
and scroll rather than being crushed to fit; tap targets get a 44px floor on coarse pointers; and
controls get a 16px font floor, because Safari zooms the viewport when a focused input's text is
smaller than that and never zooms back.

**Three bugs the pass surfaced.** `h5` and `h6` were never styled, so a facet's `###` arrived with
user-agent margins and a size smaller than the body text. The prose resets outranked the vertical
rhythm rule, silently deleting the space above every list — fixed by wrapping the resets in
`:where()` so they carry no specificity. And a facet's status chip computed its colour and its words
separately, which is how "not embedded yet" ended up wearing the green that means "embedded".

### Finding a board without knowing its slug (M9)

Adding a board needed three things you had to already know: the platform, the exact slug, and
whether the company was on an ATS this app can read at all. Get one wrong and the result was a 404
on the boards page that could not distinguish a typo from a company that simply is not on
Greenhouse. Since the registry is the denominator for every count in the application, a board that
is annoying to add is a board that does not get added — friction here corrupts the data.

**There is no catalogue to fetch, and that was checked rather than assumed.** None of the three
platforms publishes a directory of its customers: the feeds exist so a company can build its own
careers page, and enumerating every tenant is not a use case any of them serves. Third-party scraped
lists exist and were rejected — taking one would break the rule that every adapter here was written
against live data we fetched ourselves.

**What all three do answer is "is there a board at this name?"** — 404 for no, 200 for yes, no
authentication. Measured against the live endpoints before any code was written, because the cost of
a probe is what decides whether speculative probing is defensible:

| Platform   | Cheapest probe                              | Hit                                                | Miss  |
| ---------- | ------------------------------------------- | -------------------------------------------------- | ----- |
| Greenhouse | `GET /v1/boards/{slug}`                     | `200`, **28 bytes**, states the company's own name | `404` |
| Lever      | `GET /v0/postings/{slug}?mode=json&limit=1` | `200`, ~10 KB against ~1 MB unlimited              | `404` |
| Ashby      | `GET /posting-api/job-board/{slug}`         | the board                                          | `404` |

So `/boards/find` guesses well and then asks. A company name becomes at most four candidate slugs —
joined, hyphenated, first word, and the `…hq` variant that Ashby and Lever tenants often use, with
diacritics folded and legal suffixes dropped — and each platform is asked about them in order. **A
platform stops at its first hit**, and platforms run concurrently because the polite fetcher's
one-request-per-second rule is per host. Pasting a careers-page URL skips the guessing entirely and
asks exactly one question.

A confirmed hit is then read by the platform's **real adapter**, so the posting count and sample
titles shown come from the same code path that will collect the board for real. That makes the
preview a rehearsal rather than a second opinion: if the adapter cannot parse the board, you find
out before it joins the registry rather than in the coverage ledger a day later. Greenhouse's probe
also states the company's own name, so the field the form describes as "yours to author" arrives
pre-filled.

Every answer is recorded in `discovery.board_candidates`, **misses as deliberately as hits**.
"Spotify is not on Greenhouse" is a fact worth keeping, and re-deriving it on every lookup would
spend a request on a feed somebody else pays for. A hit is reused for a day and a miss for a week —
a company that moves onto Greenhouse next quarter has to be findable next quarter — and neither is a
cliff, because the page shows the as-of time and offers to ask again.

The distinction the whole thing turns on is **404 versus everything else**. A 404 is the platform
answering. A timeout is not an answer, and recording it as one would put a wrong fact in the
catalogue for a week, so the two are kept apart in the type, in the schema, and on the page.

**Decided against: bulk paste.** Twenty company names is eighty requests per host — well past what
belongs in a page load, and it would want the job-route pattern the rest of the long work already
uses to do properly. Weighed against a single-user tool adding boards one at a time anyway, it
wasn't worth the added surface, so `/boards/find` stays a one-name-at-a-time lookup.

### Seeding the dossier from a resume (M11)

The dossier's own rule from M4 still holds: **no model writes to `dossier.facts`, in any
milestone.** So `/dossier/seed` only ever produces candidates — `@domain/dossier/seed.ts` extracts a
fact set from pasted resume text and hands it back as plain data, pre-filled into the same fields
the manual "Add a fact" form uses. Nothing reaches `FactRepo.create` until the review page's own
submit, which is a human clicking, same as accepting a tailoring proposal is the only path into a
variant.

**There is no existing fact set to check citations against**, which is the opposite situation from
tailoring: there, an unknown `factId` proves the model wasn't working from what it was given, and
the whole response is rejected. Here, the source is whatever the user pasted, and "is this true" is
a judgment the review step makes, not something a schema can enforce. So the discipline is upstream,
in the prompt — extract close to the source, never invent a date or employer the resume doesn't
state — and downstream, in the UI: every field is editable before it's created, and unchecking one
leaves it out entirely.

**Bullets need a parent that doesn't have an id yet.** A role and its bullets are extracted in the
same response, before either exists as a real fact, so the model links them by a plain integer
`parentIndex` into that same response rather than a `FactId`. Creation runs in two passes — every
role and project first, then bullets resolving their parent from what just got created — and a
bullet whose parent wasn't included is skipped and reported, not created parentless.

### Writing prompts on Profile (M12)

The Dossier fact set and Profile facets are deliberately separate — different bounded contexts,
different purposes: facts are atomic and citable, facets are long-form prose written to be embedded
and matched. `embed.ts` only ever reads `FacetRepo`; nothing in the Dossier touches matching. That
split creates real friction, though: writing a facet means first deciding what to write about, and
the app already has the data to suggest an answer.

**No new gap-detection logic.** The second prompt — a posting term that appears in neither corpus —
is exactly the `unknown-territory` case `vocabulary.ts` already computes for the Gaps page, filtered
from the same report `/gaps` builds. Nothing new was written to find it.

**The first prompt needed one new function, not a new mechanism.** "A fact no facet reflects" isn't
a posting-vocabulary question — it doesn't need document-frequency thresholds or a market-relevance
filter — so it isn't routed through `findVocabularyGaps`. `findUncoveredDocuments` reuses the same
`termsIn` tokenizer directly: a fact is a candidate when it shares zero terms with the profile text.
That bar is deliberately blunt. A fact sharing even one unrelated word (both texts happen to say
"built") counts as covered, which shrinks the candidate pool from a large profile. Consistent with
this module's rule since M7 — counting is checkable, guessing at relatedness is not — and cheap to
revisit once real usage shows whether blunt is too blunt.

**No persistence, on purpose.** A prompt is picked at random from the current candidate set on every
request; "Another prompt" is a plain reload. Nothing is stored, dismissed, or tracked across visits
— matching the rest of this feature's scope: a nudge, not a queue to manage.

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
