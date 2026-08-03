/**
 * Argon2id password hashing (§11).
 *
 * hash-wasm is a WebAssembly implementation, so it needs no FFI and no native
 * addon — the process keeps running under a permission set that grants neither.
 */

import { argon2id, argon2Verify } from "hash-wasm";

/**
 * OWASP's Argon2id baseline as of writing: 19 MiB, 2 iterations, parallelism 1.
 * The parameters are encoded in the PHC string, so raising them later rehashes
 * on next login rather than invalidating existing passwords.
 */
export const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySizeKiB: 19 * 1024,
  hashLengthBytes: 32,
} as const;

const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  override readonly name = "WeakPasswordError";
}

export function assertAcceptablePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertAcceptablePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return await argon2id({
    password,
    salt,
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySizeKiB,
    hashLength: ARGON2_PARAMS.hashLengthBytes,
    outputType: "encoded",
  });
}

/**
 * Verify a password against a stored PHC string.
 *
 * A malformed or corrupt hash returns false rather than throwing: the caller is
 * a login handler, and a stored-hash problem must not be distinguishable from a
 * wrong password in the response (§11).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: storedHash });
  } catch {
    return false;
  }
}
