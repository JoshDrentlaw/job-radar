-- Tailoring (M5, §8): model-proposed rewrites and cover letters, both under the
-- fabrication constraint — every claim traces to a fact that already existed.

-- The narrative kind (open question 4, resolved): cover letters want longer-form
-- source material than resume bullets, under the same traceability guarantee.
-- Narrative facts are true statements like any other; they are simply not
-- resume-shaped, so the resume assembler skips them and the cover-letter
-- generator draws on them.
ALTER TABLE dossier.facts DROP CONSTRAINT facts_kind_check;
ALTER TABLE dossier.facts ADD CONSTRAINT facts_kind_check CHECK (kind IN
  ('summary', 'role', 'bullet', 'skill', 'education', 'project', 'narrative'));

COMMENT ON COLUMN dossier.facts.kind IS
  'narrative facts are long-form source material for cover letters; they never render on a resume.';

-- One tailoring call against one posting. Kept after the fact so a variant can
-- answer "where did this wording come from, and what was it before".
CREATE TABLE dossier.tailoring_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id       uuid        NOT NULL REFERENCES dossier.variants (id) ON DELETE CASCADE,
  -- Reference, not FK (§4): the posting may be removed with its board; the
  -- record of what was proposed against it outlives the listing.
  posting_id       text        NOT NULL,
  model            text        NOT NULL,
  fact_count       integer     NOT NULL,
  proposal_count   integer     NOT NULL,
  usage            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tailoring_runs_variant_idx ON dossier.tailoring_runs (variant_id, created_at DESC);

-- A proposed rewording of one fact. Nothing here reaches a variant until the
-- user accepts it (§8 rule 5) — this table is the review queue.
CREATE TABLE dossier.rewrite_proposals (
  id            uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid             NOT NULL REFERENCES dossier.tailoring_runs (id) ON DELETE CASCADE,
  fact_id       uuid             NOT NULL REFERENCES dossier.facts (id) ON DELETE CASCADE,
  -- The canonical text as it stood when proposed: what the reviewer compared
  -- against. Copied, not joined, so a later edit to the fact cannot silently
  -- rewrite the history of what was shown.
  source_text   text             NOT NULL,
  proposed_text text             NOT NULL,
  rationale     text             NOT NULL,
  -- Drift check (§8 rule 4). `flagged` means "look harder", never "rejected".
  similarity    double precision NOT NULL,
  novel_terms   text[]           NOT NULL DEFAULT '{}',
  flagged       boolean          NOT NULL,
  decision      text             NOT NULL DEFAULT 'pending'
                                 CHECK (decision IN ('pending', 'accepted', 'rejected')),
  decided_at    timestamptz,
  UNIQUE (run_id, fact_id)
);

CREATE INDEX rewrite_proposals_run_idx ON dossier.rewrite_proposals (run_id);

COMMENT ON COLUMN dossier.rewrite_proposals.similarity IS
  'Token-overlap similarity against source_text. Low values are where meaning drift shows up (§8).';
COMMENT ON COLUMN dossier.rewrite_proposals.novel_terms IS
  'Numbers and proper nouns present in the rewrite but absent from the source — where invented specifics show up.';

-- Generated documents. Cover letters today; §9 gives an Application a
-- coverLetterId, which is this id.
CREATE TABLE dossier.documents (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text        NOT NULL CHECK (kind IN ('cover_letter')),
  variant_id uuid        REFERENCES dossier.variants (id) ON DELETE SET NULL,
  posting_id text,
  model      text,
  status     text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dossier.document_paragraphs (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid    NOT NULL REFERENCES dossier.documents (id) ON DELETE CASCADE,
  position    integer NOT NULL,
  text        text    NOT NULL,
  rationale   text    NOT NULL,
  UNIQUE (document_id, position)
);

-- Every paragraph cites the facts it rests on. RESTRICT for the same reason
-- variant_facts uses it: a fact a document leans on cannot be hard-deleted.
CREATE TABLE dossier.document_citations (
  paragraph_id uuid NOT NULL REFERENCES dossier.document_paragraphs (id) ON DELETE CASCADE,
  fact_id      uuid NOT NULL REFERENCES dossier.facts (id) ON DELETE RESTRICT,
  PRIMARY KEY (paragraph_id, fact_id)
);

CREATE INDEX document_citations_fact_idx ON dossier.document_citations (fact_id);
