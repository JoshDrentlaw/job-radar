-- The prospect queue (§12).
--
-- M9 answered "is there a board at this name?" one name at a time, and
-- deliberately declined bulk paste: twenty names is eighty requests per host,
-- which is well past what belongs in a page load. That decision stands. What
-- changed is that there is now somewhere else to put the work.
--
-- A prospect is a company name (or a pasted board URL) that someone wants
-- asked about, sitting in a queue until a job route gets to it. Enqueuing is a
-- row insert and nothing else — no network, so a list of three hundred names
-- pastes instantly — and the asking happens on the schedule n8n owns, in
-- bounded slices, at the polite fetcher's one request per second per host.
--
-- This table holds the *question*, not the answer. Answers live in
-- discovery.board_candidates, which already records hits and misses alike and
-- is keyed (platform, slug). Draining a prospect writes there, and a prospect
-- that resolves to nothing still leaves that catalogue richer. The separation
-- matters: the queue is transient work, the catalogue is accumulated knowledge,
-- and re-enqueuing a name already asked about costs nothing because the
-- catalogue answers from cache.
--
-- Nothing here touches discovery.boards. A resolved prospect does not become a
-- board — a human still promotes it from the find page. The registry is the
-- denominator for every coverage count, so what joins it stays a decision
-- somebody made rather than a side effect of a harvest.
CREATE TABLE discovery.prospects (
  -- What the user typed, trimmed. The natural key: enqueuing the same name
  -- twice is the same question, and asking it twice is the waste this table
  -- exists to avoid.
  query       text        PRIMARY KEY,
  -- Where the name came from — "a16z portfolio", "YC W24", "manual". Free
  -- text, purely so the user can see which harvest is actually yielding boards
  -- and stop feeding the ones that are not.
  source      text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  -- The lease. Set when a run claims the row, cleared when it settles, so a
  -- run that dies mid-drain releases its claims once the lease expires rather
  -- than stranding them. Overlapping runs are not the expected case, but a
  -- retry that double-asks every name would spend somebody else's request
  -- budget to learn nothing.
  started_at  timestamptz,
  -- Null means pending. Set once the platforms answered clearly, whether the
  -- answer was a board or no board.
  resolved_at timestamptz,
  attempts    integer     NOT NULL DEFAULT 0,
  -- How many boards were found. Zero is a real answer and is stored as zero;
  -- null means the question is still open.
  hits        integer,
  -- Why the last attempt did not settle it. A timeout, a 500 — never a 404,
  -- because a 404 is the platform answering and that resolves the row. The
  -- same distinction board_candidates draws, carried up to the queue.
  last_error  text,

  CONSTRAINT prospects_hits_needs_resolution
    CHECK (hits IS NULL OR resolved_at IS NOT NULL),
  CONSTRAINT prospects_query_not_blank
    CHECK (btrim(query) <> '')
);

-- "Stripe" and "stripe" generate identical slugs, so they are the same
-- question. The original casing is kept for display; the index is what stops
-- the queue from holding both.
CREATE UNIQUE INDEX prospects_normalized_idx
  ON discovery.prospects (lower(query));

-- The claim query's index: oldest pending first, so a queue drains in the
-- order it was filled.
CREATE INDEX prospects_pending_idx
  ON discovery.prospects (enqueued_at) WHERE resolved_at IS NULL;

COMMENT ON TABLE discovery.prospects IS
  'Company names waiting to be asked about, drained in bounded slices by /api/jobs/prospect (§12).';
COMMENT ON COLUMN discovery.prospects.started_at IS
  'Lease held by an in-flight run. Expires, so a dead run does not strand its claims.';
COMMENT ON COLUMN discovery.prospects.last_error IS
  'Why the last attempt could not find out. Never a 404 — that is an answer, and it resolves the row.';
COMMENT ON COLUMN discovery.prospects.hits IS
  'Boards found. Zero is an answer; null means still pending.';
