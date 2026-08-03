/**
 * CSRF protection on every mutating form (§11).
 *
 * For an authenticated request the token is derived from the session token:
 * `sha256(sessionToken + ":csrf")`. The session token lives in an HttpOnly
 * cookie, so a cross-origin attacker cannot read it and therefore cannot compute
 * the token — and there is no extra secret to configure and no extra row to
 * store. The derivation is one-way, so the rendered token never leaks the
 * session token back.
 *
 * The login form has no session yet, so it uses a dedicated short-lived
 * HttpOnly cookie which the server also renders into the form. Same
 * double-submit shape, same inability for JS to read it.
 */

import { base64Url, randomToken, sha256Hex, timingSafeEqual } from "@platform/hash.ts";

export const CSRF_FIELD = "_csrf";
export const CSRF_COOKIE = "job_radar_csrf";
export const PRE_AUTH_CSRF_MAX_AGE_SECONDS = 60 * 60; // 1 hour

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export async function deriveCsrfToken(sessionToken: string): Promise<string> {
  const hex = await sha256Hex(`${sessionToken}:csrf`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64Url(bytes);
}

export function newPreAuthCsrfToken(): string {
  return randomToken(32);
}

export function csrfTokensMatch(expected: string, submitted: string | null): boolean {
  if (submitted === null || submitted === "" || expected === "") return false;
  return timingSafeEqual(expected, submitted);
}
