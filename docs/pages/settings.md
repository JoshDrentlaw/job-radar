# Settings — `/account`

Two tabs, both credentials: **Account** (password and passkeys — how you sign in) and **Automation**
(bearer tokens for n8n — how the scheduler signs in). Different consumers, same idea: a rotatable
credential, revocable from the UI.

## Account

One account, no registration route, no way to make a second one. Password and passkeys, and a
deliberate stance on how they relate.

### Passkeys

A second way in, not a replacement — the password stays, because a single-user app whose only
credential lives on one device is one lost phone away from locking itself out. **Register this
device** runs entirely in the browser via WebAuthn; give it a label first (e.g. "Laptop") so it's
identifiable later. Each registered credential can be **renamed** or **removed**; removing the last
one is allowed, since the password still works as a fallback. The **Synced** column shows whether a
credential is backed up across your devices or lives on just the one machine that created it.
Passkeys need a secure context (HTTPS, or `localhost` in development) — the page warns plainly when
the current context won't support the ceremony.

### Password

Requires the current password, a new one meeting the minimum length, and confirmation. Changing it
**signs out every other session immediately, including the one you just used** — you're redirected
to sign back in. There's no route to remove the password itself.

## Automation

`/automation` — bearer tokens for the `/api/jobs/*` routes n8n calls on a schedule: `collect`,
`embed`, `match`, `sweep`, and a read-only `digest`. These routes authenticate with a token, never
the session cookie — a token here grants nothing on the rest of the app, and the session cookie
grants nothing here.

### Using it

- **Mint** a token with a label (e.g. "n8n production"). The plaintext is shown exactly once, in a
  read-only field — only its hash is stored, so a lost token can't be recovered, only revoked and
  replaced.
- **Revoke** disables a token immediately. The recommended order when rotating: mint the
  replacement, paste it into n8n, _then_ revoke the old one — that way the scheduler is never left
  without a working credential in between.
- Active and revoked tokens are shown separately; revoked ones are kept (collapsed) for
  identification, not deleted outright.

### Reading job responses

The tab documents the endpoints' status-code contract directly, because it's how n8n is meant to
branch: **200** clean, **207** partial (the run finished but something failed or there's backlog
remaining — call again), **500** the run itself failed. Treat it as three states, not a pass/fail
binary.
