-- Passkeys (§11, M7). A second way in, not a replacement: the password stays,
-- because a single-user app whose only credential lives on one device is one
-- lost phone away from being locked out of itself.
--
-- Nothing here is a secret. A WebAuthn credential is a *public* key, so unlike
-- app.sessions and app.api_tokens there is nothing to hash — a disclosure of
-- this table gives an attacker material they could have asked the authenticator
-- for anyway.
CREATE TABLE app.credentials (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  -- base64url, as the browser reports it. Unique across users: a credential id
  -- identifies one authenticator key, and sign-in looks it up before it knows
  -- whose it is.
  credential_id text        NOT NULL UNIQUE,
  -- The COSE key verbatim, base64url. Stored exactly as the authenticator
  -- encoded it rather than converted to JWK or SPKI: the same discipline as
  -- discovery.postings keeping the source's own strings.
  public_key    text        NOT NULL,
  -- Authenticator use counter. Non-decreasing, and a value that goes backwards
  -- means the credential may have been cloned. Many authenticators never count
  -- and report 0 forever, which is legal.
  sign_count    bigint      NOT NULL DEFAULT 0,
  -- What the browser said about how this credential can be reached
  -- ('internal', 'hybrid', 'usb'…). Advisory, source-asserted, no CHECK.
  transports    text[]      NOT NULL DEFAULT '{}',
  -- Authenticator model identifier. Recorded, never used to decide anything —
  -- this application does not evaluate attestation.
  aaguid        text,
  -- Whether the authenticator says this credential is synced to a keychain.
  -- Worth showing the user: a device-bound passkey dies with the device.
  backed_up     boolean     NOT NULL DEFAULT false,
  -- The user's own name for the device. Not from the authenticator.
  label         text        NOT NULL DEFAULT 'Passkey',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX credentials_user_idx ON app.credentials (user_id, created_at DESC);

COMMENT ON COLUMN app.credentials.sign_count IS
  'Non-decreasing use counter. A decrease can mean a cloned authenticator; 0 forever is legal and skips the check.';
COMMENT ON COLUMN app.credentials.aaguid IS
  'Authenticator model. Recorded for the user''s benefit only — attestation is deliberately not evaluated (§11).';

-- Issued challenges. A challenge is not a secret; its whole job is to be usable
-- exactly once, so consumption is an atomic UPDATE rather than a read and a
-- write, and expiry is enforced in the same statement.
CREATE TABLE app.webauthn_challenges (
  challenge   text        PRIMARY KEY,
  purpose     text        NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  -- Set for registration, which happens inside a session; null for sign-in,
  -- which by definition has none yet.
  user_id     uuid        REFERENCES app.users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX webauthn_challenges_expiry_idx ON app.webauthn_challenges (expires_at);
