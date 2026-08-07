# Automation — `/automation`

Bearer tokens for the `/api/jobs/*` routes n8n calls on a schedule: `collect`, `embed`, `match`,
`sweep`, and a read-only `digest`. These routes authenticate with a token, never the session cookie
— a token here grants nothing on the rest of the app, and the session cookie grants nothing here.

## Using it

- **Mint** a token with a label (e.g. "n8n production"). The plaintext is shown exactly once, in a
  read-only field — only its hash is stored, so a lost token can't be recovered, only revoked and
  replaced.
- **Revoke** disables a token immediately. The recommended order when rotating: mint the
  replacement, paste it into n8n, _then_ revoke the old one — that way the scheduler is never left
  without a working credential in between.
- Active and revoked tokens are shown separately; revoked ones are kept (collapsed) for
  identification, not deleted outright.

## Reading job responses

The page documents the endpoints' status-code contract directly, because it's how n8n is meant to
branch: **200** clean, **207** partial (the run finished but something failed or there's backlog
remaining — call again), **500** the run itself failed. Treat it as three states, not a pass/fail
binary.
