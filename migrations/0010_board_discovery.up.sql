-- The board catalogue (§12).
--
-- No ATS publishes a directory of its customers, so there is nothing to import.
-- What this accumulates instead is the answers to questions this installation
-- has actually asked: for each (platform, slug) tried, whether a board was
-- there. Over time that is a catalogue of exactly the companies the user cares
-- about, which is the only one worth maintaining.
--
-- Misses are recorded as deliberately as hits. "Spotify is not on Greenhouse"
-- is a fact, and re-deriving it on every lookup would waste a request on a
-- feed someone else pays for.
--
-- Deliberately *not* a foreign key to discovery.boards, and no cascade from it.
-- A candidate is an observation about the outside world; it outlives whether we
-- happen to have registered the board, the same reasoning as run_boards.
CREATE TABLE discovery.board_candidates (
  platform      text        NOT NULL,
  slug          text        NOT NULL,
  found         boolean     NOT NULL,
  -- Stated by the platform, where it states one. Only Greenhouse does, and
  -- only for boards that exist. Never our own wording.
  company_name  text,
  -- Set only when the board was read end to end by its real adapter, so a
  -- count here means the adapter parsed it — not merely that it responded.
  posting_count integer,
  sample_titles text[]      NOT NULL DEFAULT '{}',
  -- A failure to find out, as opposed to finding out there is nothing there.
  -- The two are never conflated: found = false with error IS NULL means the
  -- platform answered clearly.
  error         text,
  -- Every candidate can show its as-of, like everything else rendered (§5).
  checked_at    timestamptz NOT NULL DEFAULT now(),
  -- The most recent thing the user typed that led here. Informational: slugs
  -- are derived deterministically, so lookups go by (platform, slug).
  query         text,

  PRIMARY KEY (platform, slug),
  CONSTRAINT board_candidates_count_needs_a_board
    CHECK (posting_count IS NULL OR found)
);

CREATE INDEX board_candidates_found_idx
  ON discovery.board_candidates (checked_at DESC) WHERE found;

COMMENT ON TABLE discovery.board_candidates IS
  'Every (platform, slug) this installation has asked about, and what the platform said (§12).';
COMMENT ON COLUMN discovery.board_candidates.error IS
  'A failure to find out. Distinct from found = false, which is a clear answer that no board exists.';
COMMENT ON COLUMN discovery.board_candidates.posting_count IS
  'Present only when the real adapter read the board, so it doubles as proof the adapter can parse it.';
