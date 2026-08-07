# Account — `/account`

One account, no registration route, no way to make a second one. Password and passkeys, and a
deliberate stance on how they relate.

## Passkeys

A second way in, not a replacement — the password stays, because a single-user app whose only
credential lives on one device is one lost phone away from locking itself out. **Register this
device** runs entirely in the browser via WebAuthn; give it a label first (e.g. "Laptop") so it's
identifiable later. Each registered credential can be **renamed** or **removed**; removing the last
one is allowed, since the password still works as a fallback. The **Synced** column shows whether a
credential is backed up across your devices or lives on just the one machine that created it.
Passkeys need a secure context (HTTPS, or `localhost` in development) — the page warns plainly when
the current context won't support the ceremony.

## Password

Requires the current password, a new one meeting the minimum length, and confirmation. Changing it
**signs out every other session immediately, including the one you just used** — you're redirected
to sign back in. There's no route to remove the password itself.

## Elsewhere

Bearer tokens for automated access live on a separate page: [Automation](automation.md).
