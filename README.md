# Job Radar

Finds roles matching demonstrated skills, and removes friction from applying to them. Single user.
Never submits anything.

See the project brief for the full design. This README covers what exists, how to run it, and what
is deliberately not here yet.

## Status

| Milestone                         | State                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| **M0 — Skeleton**                 | Done. Hono, Postgres, migration runner, password auth, sessions, default-deny router.               |
| **M1 — Boards**                   | Done except tests. Board CRUD, Greenhouse adapter, snapshot + diff, postings list, coverage ledger. |
| M2 — More adapters (Lever, Ashby) | Not started                                                                                         |
| M3 — Profile + matching           | Not started                                                                                         |
| M4 — Dossier                      | Not started                                                                                         |
| M5 — Tailoring                    | Not started                                                                                         |
| M6 — Pipeline + n8n               | Not started                                                                                         |
| M7 — Polish                       | Not started                                                                                         |

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

### Permissions

Every task declares an explicit allowlist — no blanket `-A`. The app runs with network access
limited to Postgres, its own listen port, and `boards-api.greenhouse.io`. **Adding an adapter in M2
means adding its host to the `dev` and `start` tasks**, and until you do, the adapter will fail
loudly rather than succeed quietly. That is the intended behaviour.

`PG*` appears in the env allowlist because postgres.js probes those variables for connection
defaults during option parsing. Deno supports prefix wildcards; everything outside the listed names
and that prefix is still denied.

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

### The Greenhouse adapter was written against live data

Three live boards (Vercel, Anthropic, Figma — 657 postings) were fetched and surveyed before a line
of parser was written. That established: no pagination even at 400 postings; `content` is
entity-encoded HTML on every posting using exactly the five basic XML entities; `first_published` is
the real publication date; Greenhouse publishes **no** compensation field at all; and the key set
varies slightly between boards. The parser is strict about the fields it uses and tolerant of
everything else.

The HTML→markdown converter covers the measured tag vocabulary —
`li, p, strong, div, h2, ul,
span, a, br, u, h4, h3, em, h1, ol, hr` — plus a conservative tail for
adapters still to come.

## Open questions from the brief

Flagged rather than guessed.

1. **Embedding provider** — unresolved, and it affects chunk sizing and the cost model. Nothing in
   M0/M1 depends on it. pgvector is installed and working, but the vector migration is deliberately
   deferred to M3 rather than committing to a dimension count now.

2. **Whether disappeared postings surface at all** — currently they are hidden by default with an
   explicit "include postings no longer listed" toggle, and labelled when shown. That is a
   placeholder for a real decision, not the decision.

3. **Whether `remoteHint` derivation earns its place** — there is now evidence. The derivation is
   deliberately reluctant: it asserts a modality only when the string states one, and a bare city
   name yields `unknown` rather than `onsite`, because a fully remote company listing a hub city is
   indistinguishable from an in-office role at this layer. On Vercel's board, which uses explicit
   `Hybrid - …` prefixes, it is confident and useful (70 hybrid, 11 remote). On Anthropic's and
   Figma's boards, which are mostly bare city names, it would return `unknown` for most postings. So
   it earns its place on some boards and not others. Worth a decision.

4. **Whether the fact set needs a separate narrative layer** — untouched; M4/M5 territory.

## Not here, on purpose

No auto-apply. No form-filling. No LinkedIn, Indeed or ZipRecruiter — those are declared blind
spots, permanently visible in the coverage panel, not backlog items. No headless browsers. No CSS
framework. No user roles.
