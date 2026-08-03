/**
 * Hashing helpers built on Web Crypto — no dependency, no permissions.
 */

const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL-safe random token, suitable for cookies and bearer credentials. */
export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class Base64UrlError extends Error {
  override readonly name = "Base64UrlError";
}

/**
 * Strict base64url decoding. Every WebAuthn payload arrives this way and is
 * attacker-supplied, so padding characters, whitespace and the standard
 * base64 alphabet are all rejected rather than quietly accepted — one encoding,
 * one meaning.
 */
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Base64UrlError("Not base64url");
  }
  if (value.length % 4 === 1) throw new Base64UrlError("Truncated base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Base64UrlError("Not base64url");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Compare two strings without leaking their common prefix through timing.
 * Used for CSRF tokens, where the value is attacker-influenced.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare lengths after the loop so the loop itself always runs the same way
  // for a given `a`; the length difference is not secret.
  let mismatch = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}
