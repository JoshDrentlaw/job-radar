-- Matching (M3, §7): profile facets, chunked embeddings, match records.
--
-- Vectors live in pgvector. Every vector row records the model that produced
-- it, and every consumer filters on that model: a model change re-embeds and
-- rescores explicitly rather than silently mixing vector spaces (§7).
--
-- The `vector` columns are dimension-less on purpose. The corpus is small
-- enough for exact scans (no ANN index, which would require a fixed dimension),
-- and the embedding model — and therefore its dimension — is environment
-- configuration, not schema.

CREATE EXTENSION IF NOT EXISTS vector;

-- The skill profile: long-form markdown, multiple named facets so the corpus
-- can be queried from different angles (§7). Authored in the app.
CREATE TABLE discovery.profile_facets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE,
  content      text        NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  -- sha256 of content; embedding and match rows cite it so staleness is a
  -- comparison, not a guess.
  content_hash text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Overlapping chunks of a posting's description (§7). Chunk text is stored
-- verbatim so a match can quote the exact passage that matched.
CREATE TABLE discovery.posting_chunks (
  id            uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id    text             NOT NULL REFERENCES discovery.postings (id) ON DELETE CASCADE,
  seq           integer          NOT NULL,
  text          text             NOT NULL,
  embedding     vector           NOT NULL,
  model         text             NOT NULL,
  -- provenance_content_hash of the posting at embed time; a differing hash on
  -- the posting means these chunks are stale.
  content_hash  text             NOT NULL,
  embedded_at   timestamptz      NOT NULL,
  -- Best similarity across all active facet chunks at last scoring. Null until
  -- scored. Low values are the "gaps" the match view surfaces (§7).
  best_score    double precision,
  scored_at     timestamptz,
  UNIQUE (posting_id, seq)
);

CREATE INDEX posting_chunks_posting_idx ON discovery.posting_chunks (posting_id);

CREATE TABLE discovery.facet_chunks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  facet_id     uuid        NOT NULL REFERENCES discovery.profile_facets (id) ON DELETE CASCADE,
  seq          integer     NOT NULL,
  text         text        NOT NULL,
  embedding    vector      NOT NULL,
  model        text        NOT NULL,
  content_hash text        NOT NULL,
  embedded_at  timestamptz NOT NULL,
  UNIQUE (facet_id, seq)
);

CREATE INDEX facet_chunks_facet_idx ON discovery.facet_chunks (facet_id);

-- One row per (posting, facet): the best chunk pair and its raw similarity.
-- The raw float is stored; the strong/plausible/weak bucket is applied at read
-- time from app.settings so tuning re-buckets history instead of orphaning it.
CREATE TABLE discovery.matches (
  posting_id           text             NOT NULL REFERENCES discovery.postings (id) ON DELETE CASCADE,
  facet_id             uuid             NOT NULL REFERENCES discovery.profile_facets (id) ON DELETE CASCADE,
  score                double precision NOT NULL,
  posting_chunk_id     uuid             NOT NULL REFERENCES discovery.posting_chunks (id) ON DELETE CASCADE,
  facet_chunk_id       uuid             NOT NULL REFERENCES discovery.facet_chunks (id) ON DELETE CASCADE,
  model                text             NOT NULL,
  posting_content_hash text             NOT NULL,
  facet_content_hash   text             NOT NULL,
  scored_at            timestamptz      NOT NULL,
  PRIMARY KEY (posting_id, facet_id)
);

CREATE INDEX matches_facet_idx ON discovery.matches (facet_id);
