/**
 * Router-level default deny (§11).
 *
 * Authentication is applied to `*`, not attached per route. A route added later
 * is private unless its path is added to PUBLIC_PATHS here — the failure mode of
 * forgetting is a locked door, not an open one.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "@web/types.ts";
import {
  CSRF_COOKIE,
  CSRF_FIELD,
  csrfTokensMatch,
  deriveCsrfToken,
  isMutating,
  newPreAuthCsrfToken,
  PRE_AUTH_CSRF_MAX_AGE_SECONDS,
} from "./csrf.ts";
import { SESSION_COOKIE } from "./session.ts";

/**
 * The complete public surface. Exact matches only, except for the static asset
 * prefix — which serves the login page's own stylesheet and holds no data.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/login",
  "/healthz",
  // The passkey sign-in ceremony. Public for the same reason the login form is:
  // it is how you get a session. Both still go through CSRF and the login rate
  // limiter, and neither reveals whether a credential exists.
  "/login/passkey/options",
  "/login/passkey",
]);
const PUBLIC_PREFIXES: readonly string[] = ["/static/"];

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface AuthMiddlewareDeps {
  resolveUser(token: string): Promise<import("./types.ts").User | null>;
  secureCookies: boolean;
}

/**
 * Establishes `user` and `csrfToken` on the context, then denies anything that
 * is not both authenticated and public-listed.
 */
export function sessionMiddleware(deps: AuthMiddlewareDeps): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? "";
    const user = token === "" ? null : await deps.resolveUser(token);

    if (token !== "" && user === null) {
      // The cookie is stale or forged; clear it so the browser stops sending it.
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }

    c.set("user", user);

    if (user !== null) {
      c.set("csrfToken", await deriveCsrfToken(token));
    } else {
      // Pre-auth token for the login form. HttpOnly, so only the server-rendered
      // form knows the value.
      let preAuth = getCookie(c, CSRF_COOKIE);
      if (preAuth === undefined || preAuth === "") {
        preAuth = newPreAuthCsrfToken();
        setCookie(c, CSRF_COOKIE, preAuth, {
          path: "/",
          httpOnly: true,
          secure: deps.secureCookies,
          sameSite: "Strict",
          maxAge: PRE_AUTH_CSRF_MAX_AGE_SECONDS,
        });
      }
      c.set("csrfToken", preAuth);
    }

    if (user === null && !isPublicPath(c.req.path)) {
      // URL.search is "" or already includes its leading "?".
      const target = c.req.path + new URL(c.req.url).search;
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302);
    }

    await next();
  };
}

/**
 * Reject mutating requests whose CSRF token does not match. Runs after the
 * session middleware so the expected token is already on the context.
 */
export function csrfMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    if (!isMutating(c.req.method)) return await next();

    const expected = c.get("csrfToken");
    let submitted: string | null = null;

    const contentType = c.req.header("content-type") ?? "";
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const body = await c.req.parseBody();
      const value = body[CSRF_FIELD];
      submitted = typeof value === "string" ? value : null;
    } else {
      submitted = c.req.header("x-csrf-token") ?? null;
    }

    if (!csrfTokensMatch(expected, submitted)) {
      c.get("logger").warn("csrf rejected", { path: c.req.path, method: c.req.method });
      return c.text("Invalid or missing CSRF token.", 403);
    }

    await next();
  };
}

/**
 * Strict CSP with no inline scripts, plus the usual hardening (§11). HSTS is
 * only meaningful over TLS, so it is emitted in production only.
 */
export function securityHeaders(production: boolean): MiddlewareHandler<AppEnv> {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  return async (c: Context<AppEnv>, next: Next) => {
    await next();
    c.header("Content-Security-Policy", csp);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    // The app holds a resume and contact details; keep it out of search indexes.
    c.header("X-Robots-Tag", "noindex, nofollow");
    if (production) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  };
}
