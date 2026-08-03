-- Dossier (M4, §8): the resume as structured data. The load-bearing decision:
-- documents are rendered FROM variants, never edited as blobs.

-- The canonical fact set. Every generated artifact references facts by id, so
-- ids are stable and facts are retired (active = false) rather than deleted
-- once anything references them.
CREATE TABLE dossier.facts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL CHECK (kind IN
                             ('summary', 'role', 'bullet', 'skill', 'education', 'project')),
  -- Bullets belong to roles (or projects). Deleting a parent takes its
  -- bullets with it — a bullet has no meaning without its context.
  parent_id    uuid        REFERENCES dossier.facts (id) ON DELETE CASCADE,
  -- The canonical, true statement. Variants may reword it; this is the record.
  text         text        NOT NULL,
  tags         text[]      NOT NULL DEFAULT '{}',
  start_date   date,
  end_date     date,
  organization text,
  active       boolean     NOT NULL DEFAULT true,
  -- Display order among siblings (same kind and parent).
  sort_order   integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX facts_parent_idx ON dossier.facts (parent_id);
CREATE INDEX facts_kind_idx ON dossier.facts (kind, sort_order);

COMMENT ON COLUMN dossier.facts.text IS
  'The canonical, true statement. Rewording lives on variants; new truth is added here, deliberately, by the user (§8).';

-- A variant is a diff against the fact set: which facts appear, in what
-- order, with what per-fact rewording. Nothing else.
CREATE TABLE dossier.variants (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL UNIQUE,
  parent_variant_id uuid        REFERENCES dossier.variants (id) ON DELETE SET NULL,
  -- Reference, not FK (§4): the seam between contexts is an id. A board
  -- removal cascades its postings, and that must never destroy or block a
  -- variant — the variant outlives the listing it targeted.
  target_posting_id text,
  frozen            boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN dossier.variants.frozen IS
  'Set when actually sent (M6) or by hand. Frozen variants are immutable history (§8).';

-- Which facts a variant includes, in order, with optional manual rewording.
-- RESTRICT: a fact that any variant cites cannot be hard-deleted — retire it.
CREATE TABLE dossier.variant_facts (
  variant_id     uuid    NOT NULL REFERENCES dossier.variants (id) ON DELETE CASCADE,
  fact_id        uuid    NOT NULL REFERENCES dossier.facts (id) ON DELETE RESTRICT,
  position       integer NOT NULL,
  rewritten_text text,
  PRIMARY KEY (variant_id, fact_id)
);

CREATE INDEX variant_facts_fact_idx ON dossier.variant_facts (fact_id);
