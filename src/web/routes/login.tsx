/** @jsxImportSource hono/jsx */

/**
 * Login. There is no registration route — not disabled, absent (§11). The admin
 * account is created by the seed-admin task at deploy time.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";
import { BareLayout } from "@web/layout.tsx";
import { CsrfField, Notice } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { CSRF_COOKIE } from "@auth/csrf.ts";
import { ABSOLUTE_LIFETIME_MS, SESSION_COOKIE } from "@auth/session.ts";
import { verifyPassword } from "@auth/password.ts";

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
    </section>
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
  const config = c.get("config");
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
  const { token } = await services.sessions.issue(user.id, {
    userAgent: c.req.header("user-agent") ?? null,
    ip,
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

  logger.info("login succeeded", { ip, userId: user.id });
  return c.redirect(next, 303);
});

loginRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token !== undefined) await c.get("services").sessions.revokeByToken(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login?signedout", 303);
});
