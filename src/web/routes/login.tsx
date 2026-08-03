/** @jsxImportSource hono/jsx */

/**
 * Login. There is no registration route — not disabled, absent (§11). The admin
 * account is created by the seed-admin task at deploy time.
 */

import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";
import { BareLayout } from "@web/layout.tsx";
import { CsrfField, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { UserId } from "@platform/ids.ts";
import { CSRF_COOKIE } from "@auth/csrf.ts";
import { ABSOLUTE_LIFETIME_MS, SESSION_COOKIE } from "@auth/session.ts";
import { verifyPassword } from "@auth/password.ts";
import type { AuthenticationResponse } from "@auth/webauthn/ceremony.ts";
import { WebAuthnError } from "@auth/webauthn/ceremony.ts";

/**
 * Only same-site absolute paths are accepted as a post-login destination.
 * `//evil.example` is a protocol-relative URL and must not survive this.
 */
export function safeRedirectTarget(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "/";
  let candidate: string;
  try {
    candidate = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  if (candidate.includes("\\")) return "/";
  return candidate;
}

const LoginPage: FC<{ csrfToken: string; next: string; error?: string; notice?: string }> = (
  props,
) => (
  <BareLayout title="Sign in">
    <section class="panel stack">
      <header>
        <h1 class="title-compact">Job Radar</h1>
      </header>
      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice>{props.notice}</Notice>}
      <form method="post" action="/login" class="stack">
        <CsrfField token={props.csrfToken} />
        <input type="hidden" name="next" value={props.next} />
        <div>
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            required
            autofocus
          />
        </div>
        <div>
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <button type="submit" class="primary">Sign in</button>
      </form>

      {
        /*
        Progressive enhancement, not a fallback (§3): this button ships hidden
        and the script reveals it only where WebAuthn exists. With scripting
        off, the password form above is the whole page and works.
      */
      }
      <div class="passkey-row">
        <button
          type="button"
          class="quiet"
          hidden
          data-passkey-signin
          data-csrf={props.csrfToken}
          data-next={props.next}
        >
          Sign in with a passkey
        </button>
        <p class="notice warn" hidden data-passkey-status></p>
      </div>
    </section>
    <script src="/static/webauthn.js" defer></script>
  </BareLayout>
);

export const loginRoutes = new Hono<AppEnv>();

loginRoutes.get("/login", (c) => {
  if (c.get("user") !== null) return c.redirect("/", 302);
  const next = safeRedirectTarget(c.req.query("next"));
  const notice = c.req.query("signedout") !== undefined ? "You have been signed out." : undefined;
  return c.html(
    <LoginPage
      csrfToken={c.get("csrfToken")}
      next={next}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

loginRoutes.post("/login", async (c) => {
  const services = c.get("services");
  const logger = c.get("logger");
  const ip = c.get("clientIp");

  const body = await c.req.parseBody();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const next = safeRedirectTarget(typeof body.next === "string" ? body.next : undefined);

  const render = (error: string, status: 400 | 401 | 429) =>
    c.html(<LoginPage csrfToken={c.get("csrfToken")} next={next} error={error} />, status);

  const decision = await services.rateLimiter.check(ip);
  if (!decision.allowed) {
    logger.warn("login throttled", { ip, retryAfter: decision.retryAfterSeconds });
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return render(
      `Too many attempts. Try again in ${decision.retryAfterSeconds} seconds.`,
      429,
    );
  }

  if (username === "" || password === "") {
    return render("Enter a username and password.", 400);
  }

  const user = await services.users.findByUsername(username);
  // The response must not distinguish "bad user" from "bad password" (§11), so
  // both paths produce the same message — and a missing user still pays the
  // cost of a verification against a dummy hash, so the timing does not tell
  // the difference either.
  const stored = user?.passwordHash ??
    "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await verifyPassword(password, stored);

  if (!ok || user === null) {
    await services.rateLimiter.recordFailure(ip, username);
    logger.warn("login failed", { ip, username });
    return render("Incorrect username or password.", 401);
  }

  await services.rateLimiter.recordSuccess(ip, username);
  await startSession(c, user.id);

  logger.info("login succeeded", { ip, userId: user.id, via: "password" });
  return c.redirect(next, 303);
});

/**
 * Issue the session cookie. Shared by both ways in, so a passkey sign-in and a
 * password sign-in produce exactly the same session — same lifetime, same
 * flags, same retirement of the pre-auth CSRF cookie.
 */
async function startSession(c: Context<AppEnv>, userId: UserId): Promise<void> {
  const config = c.get("config");
  const { token } = await c.get("services").sessions.issue(userId, {
    userAgent: c.req.header("user-agent") ?? null,
    ip: c.get("clientIp"),
  });

  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Strict",
    maxAge: Math.floor(ABSOLUTE_LIFETIME_MS / 1000),
  });
  // The pre-auth CSRF cookie has done its job; the session-derived token
  // takes over from here.
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
}

/**
 * Hand the browser a challenge to sign. Deliberately says nothing about whether
 * any passkey is registered — the options are identical either way, so this
 * endpoint cannot be used to probe.
 */
loginRoutes.post("/login/passkey/options", async (c) => {
  const services = c.get("services");
  const decision = await services.rateLimiter.check(c.get("clientIp"));
  if (!decision.allowed) {
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return c.json(
      { error: `Too many attempts. Try again in ${decision.retryAfterSeconds}s.` },
      429,
    );
  }
  return c.json(await services.passkeys.beginAuthentication());
});

loginRoutes.post("/login/passkey", async (c) => {
  const services = c.get("services");
  const logger = c.get("logger");
  const ip = c.get("clientIp");

  const decision = await services.rateLimiter.check(ip);
  if (!decision.allowed) {
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return c.json(
      { error: `Too many attempts. Try again in ${decision.retryAfterSeconds}s.` },
      429,
    );
  }

  let body: AuthenticationResponse;
  try {
    body = await c.req.json() as AuthenticationResponse;
  } catch {
    return c.json({ error: "Malformed request." }, 400);
  }

  let credential;
  try {
    credential = await services.passkeys.finishAuthentication(body);
  } catch (error) {
    // Passkey failures share the login rate limiter with passwords: an attacker
    // must not get an unthrottled oracle just by switching endpoint.
    await services.rateLimiter.recordFailure(ip, "passkey");
    if (error instanceof WebAuthnError) {
      logger.warn("passkey sign-in refused", { ip, reason: error.message });
      return c.json({ error: error.message }, 401);
    }
    throw error;
  }

  await services.rateLimiter.recordSuccess(ip, "passkey");
  await startSession(c, credential.userId);

  logger.info("login succeeded", {
    ip,
    userId: credential.userId,
    via: "passkey",
    credentialId: credential.id,
  });
  const next = safeRedirectTarget(
    typeof (body as { next?: string }).next === "string" ? (body as { next?: string }).next : "/",
  );
  return c.json({ redirect: next });
});

loginRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token !== undefined) await c.get("services").sessions.revokeByToken(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login?signedout", 303);
});
