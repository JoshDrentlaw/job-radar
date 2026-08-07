/** @jsxImportSource hono/jsx */

/**
 * The account page: passkeys and the password.
 *
 * Two things live here for the same reason — both were previously only
 * reachable by having shell access to the box. Changing a password meant
 * re-running the seed task; there was no way at all to enrol a device.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDateTime, Notice, relativeAge, Tabs } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { Credential } from "@auth/webauthn/service.ts";
import { type RegistrationResponse, WebAuthnError } from "@auth/webauthn/ceremony.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "@auth/password.ts";

const NOTICES: Record<string, string> = {
  "passkey-added": "That device is registered. You can sign in with it from now on.",
  "passkey-removed": "That passkey has been removed and can no longer sign in.",
  "passkey-renamed": "Renamed.",
  "password-changed": "Your password has been changed. Other sessions have been signed out.",
};

const AccountPage: FC<{
  username: string;
  credentials: readonly Credential[];
  rpId: string;
  secureContext: boolean;
  csrfToken: string;
  now: Date;
  notice?: string;
  error?: string;
}> = (props) => (
  <Layout title="Account" current="settings" csrfToken={props.csrfToken}>
    <Tabs
      label="Settings sections"
      items={[
        { href: "/account", label: "Account", current: true },
        { href: "/automation", label: "Automation" },
      ]}
    />
    <div class="page-head">
      <div>
        <h1>Account</h1>
        <p class="lede">
          Signed in as{" "}
          <strong>{props.username}</strong>. There is one account and no way to make another.
        </p>
      </div>
    </div>

    {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}
    {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}

    <section class="panel">
      <header>
        <h2>Passkeys</h2>
        <span class="chip">{props.credentials.length} registered</span>
      </header>
      <p class="panel-note">
        A passkey signs you in with the fingerprint, face or PIN your device already checks — no
        password typed, nothing to phish, and it only works on{" "}
        <code>{props.rpId}</code>. The password stays: a single-user application whose only
        credential lives on one device is one lost phone away from being locked out of itself.
      </p>

      {!props.secureContext && (
        <Notice kind="warn">
          Passkeys need HTTPS (or localhost). This page is being served from an origin browsers
          treat as insecure, so the browser will refuse the ceremony.
        </Notice>
      )}

      {props.credentials.length === 0
        ? <p class="empty gap-above">No passkeys yet. Register this device below.</p>
        : (
          <div class="table-scroll gap-above">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th>Synced</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.credentials.map((credential) => (
                  <tr key={credential.id}>
                    <td>
                      <form
                        method="post"
                        action={`/account/passkeys/${credential.id}/rename`}
                        class="inline-form"
                      >
                        <CsrfField token={props.csrfToken} />
                        <input
                          type="text"
                          name="label"
                          value={credential.label}
                          maxlength={60}
                          aria-label="Device name"
                        />
                        <button type="submit" class="quiet">Rename</button>
                      </form>
                      {credential.transports.length > 0 && (
                        <p class="field-hint">{credential.transports.join(", ")}</p>
                      )}
                    </td>
                    <td title={formatDateTime(credential.createdAt)}>
                      {relativeAge(credential.createdAt, props.now)}
                    </td>
                    <td
                      title={credential.lastUsedAt === null
                        ? "Never used"
                        : formatDateTime(credential.lastUsedAt)}
                    >
                      {credential.lastUsedAt === null
                        ? "never"
                        : relativeAge(credential.lastUsedAt, props.now)}
                    </td>
                    <td>
                      {credential.backedUp
                        ? <span class="chip ok">yes</span>
                        : (
                          <span class="chip warn" title="This passkey exists only on that device.">
                            device only
                          </span>
                        )}
                    </td>
                    <td class="numeric">
                      <form method="post" action={`/account/passkeys/${credential.id}/delete`}>
                        <CsrfField token={props.csrfToken} />
                        <button type="submit" class="danger quiet">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <div class="passkey-row gap-above">
        <label for="passkey-label">Name for this device</label>
        <input
          id="passkey-label"
          type="text"
          maxlength={60}
          placeholder="Laptop"
          data-passkey-label
        />
        <button
          type="button"
          class="primary"
          hidden
          data-passkey-register
          data-csrf={props.csrfToken}
        >
          Register this device
        </button>
        <p class="notice warn" hidden data-passkey-register-status></p>
        <p class="field-hint" hidden data-passkey-unsupported>
          This browser does not support passkeys, so there is nothing to register here. The password
          form below still works.
        </p>
      </div>
    </section>

    <section class="panel">
      <header>
        <h2>Password</h2>
      </header>
      <p class="panel-note">
        Changing this signs out every other session, including any left open on a device you no
        longer have.
      </p>
      <form method="post" action="/account/password" class="stack gap-above">
        <CsrfField token={props.csrfToken} />
        <div>
          <label for="current">Current password</label>
          <input
            id="current"
            name="current"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <div>
          <label for="next">New password</label>
          <input
            id="next"
            name="next"
            type="password"
            autocomplete="new-password"
            minlength={MIN_PASSWORD_LENGTH}
            required
          />
          <p class="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>
        <div>
          <label for="confirm">New password again</label>
          <input id="confirm" name="confirm" type="password" autocomplete="new-password" required />
        </div>
        <button type="submit" class="primary">Change password</button>
      </form>
    </section>
    <script src="/static/webauthn.js" defer></script>
  </Layout>
);

export const accountRoutes = new Hono<AppEnv>();

/** WebAuthn only runs in a secure context; say so rather than let it fail silently. */
function isSecureContext(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

accountRoutes.get("/account", async (c) => {
  const services = c.get("services");
  const user = c.get("user")!;
  const credentials = await services.passkeys.listForUser(user.id);
  const noticeKey = c.req.query("notice") ?? "";
  const errorKey = c.req.query("error") ?? "";

  return c.html(
    <AccountPage
      username={user.username}
      credentials={credentials}
      rpId={services.passkeys.rpId}
      secureContext={isSecureContext(c.get("config").baseUrl)}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(NOTICES[noticeKey] !== undefined ? { notice: NOTICES[noticeKey]! } : {})}
      {...(errorKey !== "" ? { error: errorKey } : {})}
    />,
  );
});

accountRoutes.post("/account/passkeys/options", async (c) => {
  const user = c.get("user")!;
  return c.json(await c.get("services").passkeys.beginRegistration(user));
});

accountRoutes.post("/account/passkeys", async (c) => {
  const services = c.get("services");
  const user = c.get("user")!;

  let body: RegistrationResponse & { label?: string };
  try {
    body = await c.req.json() as RegistrationResponse & { label?: string };
  } catch {
    return c.json({ error: "Malformed request." }, 400);
  }

  try {
    const credential = await services.passkeys.finishRegistration(user, body.label ?? "", body);
    c.get("logger").info("passkey registered", {
      userId: user.id,
      credentialId: credential.id,
      backedUp: credential.backedUp,
    });
    return c.json({ id: credential.id, label: credential.label });
  } catch (error) {
    if (error instanceof WebAuthnError) {
      c.get("logger").warn("passkey registration refused", { reason: error.message });
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

accountRoutes.post("/account/passkeys/:id/rename", async (c) => {
  const body = await c.req.parseBody();
  const label = typeof body.label === "string" ? body.label : "";
  await c.get("services").passkeys.rename(c.req.param("id") ?? "", label);
  return c.redirect("/account?notice=passkey-renamed", 303);
});

accountRoutes.post("/account/passkeys/:id/delete", async (c) => {
  const services = c.get("services");
  const user = c.get("user")!;
  const id = c.req.param("id") ?? "";

  // Removing a passkey is fine even if it is the last one — the password is
  // still there. Removing the *password* is what there is no route for.
  const credentials = await services.passkeys.listForUser(user.id);
  if (!credentials.some((credential) => credential.id === id)) {
    return c.redirect("/account?error=That+passkey+is+not+registered.", 303);
  }

  await services.passkeys.remove(id);
  c.get("logger").info("passkey removed", { userId: user.id, credentialId: id });
  return c.redirect("/account?notice=passkey-removed", 303);
});

accountRoutes.post("/account/password", async (c) => {
  const services = c.get("services");
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  const fail = (message: string) =>
    c.redirect(`/account?error=${encodeURIComponent(message)}`, 303);

  const stored = await services.users.findByUsername(user.username);
  if (stored === null || !await verifyPassword(current, stored.passwordHash)) {
    c.get("logger").warn("password change refused", { userId: user.id, reason: "bad current" });
    return fail("That is not your current password.");
  }
  if (next !== confirm) return fail("The two new passwords do not match.");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return fail(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (next === current) return fail("That is already your password.");

  await services.users.updatePasswordHash(user.id, await hashPassword(next));
  // Every other session was authorised by the old password; none of them
  // should outlive it. This one included — signing back in proves the change.
  await services.sessions.revokeAllForUser(user.id);
  c.get("logger").info("password changed", { userId: user.id });
  return c.redirect("/login?signedout", 303);
});
