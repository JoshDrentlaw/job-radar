-- Foundation: schema namespaces and authentication.
--
-- The three bounded contexts (§4) get genuinely separate namespaces. Nothing in
-- `discovery` may reference `dossier` or `pipeline` except through the two seams
-- the brief allows: a match starting an application, and an application
-- referencing a resume variant. Both are id references, added in their own
-- migrations when those contexts arrive.

CREATE SCHEMA IF NOT EXISTS app;        -- cross-cutting: auth, sessions, settings
CREATE SCHEMA IF NOT EXISTS discovery;  -- boards, postings, snapshots, matching
CREATE SCHEMA IF NOT EXISTS dossier;    -- resume facts, variants, documents
CREATE SCHEMA IF NOT EXISTS pipeline;   -- applications and their timelines

COMMENT ON SCHEMA discovery IS 'Bounded context: what is being hired for, and where we learned it.';
COMMENT ON SCHEMA dossier   IS 'Bounded context: the resume as structured data.';
COMMENT ON SCHEMA pipeline  IS 'Bounded context: what was sent where, and what happened.';

-- Single user, forever (§2). No roles column, no teams, no invitations.
-- The account is seeded by a deploy-time task; there is no registration route.
CREATE TABLE app.users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN app.users.password_hash IS 'Argon2id PHC string. Parameters live inside the hash so they can be raised later.';

-- Sessions live in Postgres so they are revocable and survive a restart (§11).
-- `id` is a SHA-256 of the cookie token, never the token itself: a database
-- read must not hand someone a working session.
CREATE TABLE app.sessions (
  id                 text        PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at         timestamptz,
  user_agent         text,
  ip                 inet
);

CREATE INDEX sessions_user_idx ON app.sessions (user_id);
CREATE INDEX sessions_expiry_idx ON app.sessions (absolute_expires_at);

COMMENT ON COLUMN app.sessions.id IS 'sha256(cookie token). The raw token exists only in the cookie.';
COMMENT ON COLUMN app.sessions.last_seen_at IS 'Drives idle expiry; absolute_expires_at caps total lifetime.';

-- Login attempts drive progressive backoff by IP and give failed logins a
-- durable record (§11). The attempted username is recorded for the operator's
-- own forensics; it is never echoed back to the client.
CREATE TABLE app.login_attempts (
  id         bigserial   PRIMARY KEY,
  ip         inet        NOT NULL,
  username   text        NOT NULL,
  succeeded  boolean     NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_ip_at_idx ON app.login_attempts (ip, at DESC);

-- Key/value settings that are genuinely configuration rather than secrets:
-- similarity bucket thresholds (§7) and the like. Secrets stay in the
-- environment (§11) and must never be written here.
CREATE TABLE app.settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
