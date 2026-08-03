-- Pipeline (M6, §9): what was sent where, when, with which variant, and what
-- happened. Plus the bearer tokens n8n authenticates with (§11, §12).

CREATE TABLE pipeline.applications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- References across the context seam (§4), not foreign keys: an application
  -- is a record of something that happened and must outlive the listing it was
  -- sent to. A board removal cascades its postings; it must not erase history.
  posting_id      text        NOT NULL,
  variant_id      uuid        NOT NULL,
  cover_letter_id uuid,
  -- Denormalized at send time so the record still reads correctly when the
  -- posting is gone. This is the same reasoning as rewrite_proposals copying
  -- source_text: history must not silently rewrite itself.
  posting_title   text        NOT NULL,
  company_name    text        NOT NULL,
  apply_url       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'drafting' CHECK (status IN
                    ('drafting', 'sent', 'acknowledged', 'screening', 'interviewing',
                     'rejected', 'ghosted', 'withdrawn', 'offer')),
  sent_at         timestamptz,
  -- Any inbound or outbound activity. Drives the ghosting rule; distinct from
  -- updated_at, which changes when the user edits a note.
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  notes           text        NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One live application per posting. A withdrawn or rejected one can be
  -- superseded, so this is a partial index rather than a plain UNIQUE.
  CONSTRAINT applications_variant_required CHECK (variant_id IS NOT NULL)
);

CREATE UNIQUE INDEX applications_open_posting_idx
  ON pipeline.applications (posting_id)
  WHERE status NOT IN ('withdrawn', 'rejected');

CREATE INDEX applications_status_idx ON pipeline.applications (status, last_activity_at);

COMMENT ON COLUMN pipeline.applications.status IS
  'ghosted means no activity for the configured window — an honest name for a stale row, not an inference about the employer (§9).';
COMMENT ON COLUMN pipeline.applications.variant_id IS
  'Frozen at send time (§9). The variant itself is frozen so the document that was sent stays renderable.';

-- Append-only timeline (§9). Rows are never updated or deleted; a correction
-- is another row.
CREATE TABLE pipeline.application_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid        NOT NULL REFERENCES pipeline.applications (id) ON DELETE CASCADE,
  kind           text        NOT NULL CHECK (kind IN
                   ('created', 'status_changed', 'note', 'sent')),
  from_status    text,
  to_status      text,
  detail         text        NOT NULL DEFAULT '',
  -- Who caused it. 'rule' is the ghosting sweep; the distinction matters when
  -- reading a timeline back, since a rule-set status is not an observation.
  source         text        NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'rule')),
  at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_events_app_idx ON pipeline.application_events (application_id, at DESC);

-- Bearer tokens for the n8n trigger routes (§11, §12).
--
-- §11 says secrets live in the environment, never the database — and also that
-- this token is rotatable from the UI. Both hold here because what is stored is
-- a SHA-256 of the token, exactly as app.sessions stores a hash of the session
-- cookie. A database disclosure yields no usable credential; the plaintext is
-- shown once at creation and never again.
CREATE TABLE app.api_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text        NOT NULL,
  token_hash   text        NOT NULL UNIQUE,
  -- First few characters, for telling two tokens apart in the UI. Not a secret.
  token_prefix text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

COMMENT ON TABLE app.api_tokens IS
  'sha256 of the bearer token only. The plaintext exists once, at creation, and is never stored.';
