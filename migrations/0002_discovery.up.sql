-- Discovery: boards, postings, snapshots, and the coverage ledger.
--
-- Two rules are enforced structurally here rather than by convention:
--
--   1. Provenance is non-nullable (§5). Every posting row can state which
--      adapter version produced it, from exactly which URL, and as of when.
--      Anything the UI renders can therefore show its as-of timestamp.
--
--   2. Source-asserted and derived fields are separated (§5). Everything the
--      feed actually said lives in `postings`. Everything we computed lives in
--      `posting_derived`, which can be truncated and rebuilt without touching a
--      single asserted value, and which carries the version of the rules that
--      produced it.

CREATE TABLE discovery.boards (
  id                   text        PRIMARY KEY,   -- '{platform}:{slug}'
  platform             text        NOT NULL,
  slug                 text        NOT NULL,
  company_name         text        NOT NULL,      -- authored by the user, not the feed
  active               boolean     NOT NULL DEFAULT true,
  notes                text,
  tags                 text[]      NOT NULL DEFAULT '{}',
  added_at             timestamptz NOT NULL DEFAULT now(),
  last_fetch_status    text        NOT NULL DEFAULT 'never',
  last_fetch_at        timestamptz,
  last_fetch_error     text,
  consecutive_failures integer     NOT NULL DEFAULT 0,

  CONSTRAINT boards_platform_slug_key UNIQUE (platform, slug),
  CONSTRAINT boards_last_fetch_status_check
    CHECK (last_fetch_status IN ('ok', 'failed', 'never')),
  CONSTRAINT boards_consecutive_failures_check CHECK (consecutive_failures >= 0)
);

CREATE INDEX boards_active_idx ON discovery.boards (active) WHERE active;

COMMENT ON COLUMN discovery.boards.company_name IS 'User-authored. Feeds disagree with themselves about company naming; the user decides.';
COMMENT ON COLUMN discovery.boards.consecutive_failures IS 'Crossing a threshold almost always means a slug changed or the company moved ATS (§12).';

-- Source-asserted posting data. Every column here is verbatim from the feed,
-- with the single exception of description_text, which is the feed's HTML
-- losslessly converted to markdown.
CREATE TABLE discovery.postings (
  id               text        PRIMARY KEY,  -- '{boardId}:{externalId}'
  board_id         text        NOT NULL REFERENCES discovery.boards (id) ON DELETE CASCADE,
  external_id      text        NOT NULL,

  title            text        NOT NULL,
  location_raw     text        NOT NULL,     -- the original string, never normalized in place
  employment_type  text,
  department       text,
  description_text text        NOT NULL,     -- HTML converted to markdown
  compensation     jsonb,                    -- null when the source does not publish it
  apply_url        text        NOT NULL,
  posted_at        timestamptz,              -- only when the source actually provides it

  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  -- False means 'no longer listed' and nothing more. Not filled, not cancelled,
  -- not closed (§6). Disappeared postings are kept.
  currently_listed boolean     NOT NULL DEFAULT true,

  -- Provenance (§5). All NOT NULL, by design.
  provenance_platform        text        NOT NULL,
  provenance_adapter_version text        NOT NULL,
  provenance_source_url      text        NOT NULL,
  provenance_fetched_at      timestamptz NOT NULL,
  provenance_content_hash    text        NOT NULL,

  CONSTRAINT postings_board_external_key UNIQUE (board_id, external_id)
);

CREATE INDEX postings_board_idx ON discovery.postings (board_id);
CREATE INDEX postings_listed_idx ON discovery.postings (currently_listed) WHERE currently_listed;
CREATE INDEX postings_last_seen_idx ON discovery.postings (last_seen_at DESC);

COMMENT ON COLUMN discovery.postings.currently_listed IS 'No longer listed. Says nothing about whether the role was filled (§6).';
COMMENT ON COLUMN discovery.postings.provenance_content_hash IS 'Our hash of normalized title+location+description. Authoritative; source updated_at is display metadata only (§6).';

-- Derived fields. Guesses live here so a guess can say it is a guess (§5).
CREATE TABLE discovery.posting_derived (
  posting_id         text        PRIMARY KEY REFERENCES discovery.postings (id) ON DELETE CASCADE,
  location_normalized text,
  remote_hint        text        NOT NULL DEFAULT 'unknown',
  -- Bumped whenever the derivation rules change, so stale guesses are findable.
  derivation_version text        NOT NULL,
  derived_at         timestamptz NOT NULL,

  CONSTRAINT posting_derived_remote_hint_check
    CHECK (remote_hint IN ('remote', 'hybrid', 'onsite', 'unknown'))
);

COMMENT ON TABLE discovery.posting_derived IS 'Computed, not asserted. Safe to truncate and rebuild.';

-- A collection run is one pass over the active boards. It is the coverage
-- ledger's backing record (§10): every count the UI shows can name its
-- denominator and its failures.
CREATE TABLE discovery.collection_runs (
  id                    uuid        PRIMARY KEY,
  started_at            timestamptz NOT NULL,
  finished_at           timestamptz,
  boards_configured     integer     NOT NULL DEFAULT 0,
  boards_fetched        integer     NOT NULL DEFAULT 0,
  boards_failed         integer     NOT NULL DEFAULT 0,
  postings_seen         integer     NOT NULL DEFAULT 0,
  postings_new          integer     NOT NULL DEFAULT 0,
  postings_changed      integer     NOT NULL DEFAULT 0,
  postings_disappeared  integer     NOT NULL DEFAULT 0,
  trigger               text        NOT NULL DEFAULT 'manual',

  CONSTRAINT collection_runs_trigger_check CHECK (trigger IN ('manual', 'scheduled'))
);

CREATE INDEX collection_runs_started_idx ON discovery.collection_runs (started_at DESC);

-- One full snapshot per board per run (§6). No incremental deltas: the diff is
-- computed by comparing two complete sets.
CREATE TABLE discovery.snapshots (
  id            uuid        PRIMARY KEY,
  board_id      text        NOT NULL REFERENCES discovery.boards (id) ON DELETE CASCADE,
  run_id        uuid        REFERENCES discovery.collection_runs (id) ON DELETE SET NULL,
  taken_at      timestamptz NOT NULL,
  status        text        NOT NULL,
  error_reason  text,
  posting_count integer     NOT NULL DEFAULT 0,
  source_url    text        NOT NULL,
  adapter_version text      NOT NULL,

  CONSTRAINT snapshots_status_check CHECK (status IN ('ok', 'failed'))
);

-- The lookup behind "what did the previous successful fetch of this board see?"
CREATE INDEX snapshots_board_taken_idx
  ON discovery.snapshots (board_id, taken_at DESC)
  WHERE status = 'ok';

CREATE TABLE discovery.snapshot_entries (
  snapshot_id  uuid NOT NULL REFERENCES discovery.snapshots (id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  content_hash text NOT NULL,

  PRIMARY KEY (snapshot_id, external_id)
);

COMMENT ON TABLE discovery.snapshot_entries IS 'Complete set of posting ids + content hashes at a point in time. The diff input.';
