-- Per-board detail for a collection run (§10).
--
-- The run row records the totals. This records who contributed what, so that
-- "12 new postings" can answer "from which boards, and which boards
-- contributed nothing because we could not read them?" — the denominator,
-- broken out.
--
-- Deliberately *not* a foreign key on board_id, and the company name is
-- copied. This table is history: removing a board takes it out of future runs,
-- it does not rewrite what a past run saw. Same reasoning as the denormalized
-- columns on pipeline.applications.
CREATE TABLE discovery.run_boards (
  run_id        uuid    NOT NULL REFERENCES discovery.collection_runs (id) ON DELETE CASCADE,
  board_id      text    NOT NULL,
  company_name  text    NOT NULL,
  status        text    NOT NULL CHECK (status IN ('ok', 'failed')),
  -- Present when status is 'failed'. Never a code — the text the board gave us.
  reason        text,
  postings_seen integer NOT NULL DEFAULT 0,
  appeared      integer NOT NULL DEFAULT 0,
  changed       integer NOT NULL DEFAULT 0,
  disappeared   integer NOT NULL DEFAULT 0,

  PRIMARY KEY (run_id, board_id)
);

COMMENT ON TABLE discovery.run_boards IS
  'One row per board per collection run. The per-board breakdown behind the run totals (§10).';
COMMENT ON COLUMN discovery.run_boards.disappeared IS
  'Absent from this fetch relative to the previous successful one. Says nothing about whether the role was filled (§6).';
