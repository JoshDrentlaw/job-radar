/**
 * The passkey use-cases, over ports (§4, §11).
 *
 * Both ceremonies are two round trips: we issue a challenge and remember it,
 * the browser signs it, we check the signature against the challenge we issued
 * and then forget it. "Forget it" is the important half — a challenge that can
 * be used twice is not a challenge, so consumption is a single atomic
 * statement in the repository rather than a read followed by a write.
 *
 * Credentials are **discoverable** (resident): the authenticator stores who you
 * are, so signing in needs no username first. With one user and no registration
 * route, asking "who are you?" before "prove it" would be theatre.
 */

import type { Clock } from "@platform/clock.ts";
import { base64Url, randomToken } from "@platform/hash.ts";
import type { UserId } from "@platform/ids.ts";
import {
  type AuthenticationResponse,
  type ExpectedOrigin,
  type RegistrationResponse,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./ceremony.ts";
import { SUPPORTED_ALGORITHMS } from "./cose.ts";

/** A registered authenticator. The public key is not a secret; the label is the user's. */
export interface Credential {
  readonly id: string;
  readonly userId: UserId;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface NewCredential {
  readonly userId: UserId;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly label: string;
}

export interface CredentialRepo {
  listForUser(userId: UserId): Promise<Credential[]>;
  findByCredentialId(credentialId: string): Promise<Credential | null>;
  create(credential: NewCredential): Promise<Credential>;
  recordUse(id: string, signCount: number, at: Date): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  remove(id: string): Promise<void>;
  countForUser(userId: UserId): Promise<number>;
}

export type ChallengePurpose = "register" | "authenticate";

export interface ChallengeRepo {
  /** Store an unused challenge. */
  create(input: {
    challenge: string;
    purpose: ChallengePurpose;
    userId: UserId | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Mark a challenge used and report whether it was still usable. Must be a
   * single statement: a check followed by a separate write is a race that
   * allows a replay.
   */
  consume(challenge: string, purpose: ChallengePurpose, at: Date): Promise<
    { userId: UserId | null } | null
  >;
  deleteExpired(before: Date): Promise<number>;
}

/** Long enough to survive a fingerprint retry, short enough to be worthless later. */
export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export class PasskeyService {
  readonly #credentials: CredentialRepo;
  readonly #challenges: ChallengeRepo;
  readonly #clock: Clock;
  readonly #expected: ExpectedOrigin;

  constructor(
    credentials: CredentialRepo,
    challenges: ChallengeRepo,
    clock: Clock,
    expected: ExpectedOrigin,
  ) {
    this.#credentials = credentials;
    this.#challenges = challenges;
    this.#clock = clock;
    this.#expected = expected;
  }

  get rpId(): string {
    return this.#expected.rpId;
  }

  listForUser(userId: UserId): Promise<Credential[]> {
    return this.#credentials.listForUser(userId);
  }

  countForUser(userId: UserId): Promise<number> {
    return this.#credentials.countForUser(userId);
  }

  async #issueChallenge(purpose: ChallengePurpose, userId: UserId | null): Promise<string> {
    const challenge = randomToken(32);
    const createdAt = this.#clock.now();
    await this.#challenges.create({
      challenge,
      purpose,
      userId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + CHALLENGE_LIFETIME_MS),
    });
    return challenge;
  }

  /**
   * Options for `navigator.credentials.create`. `excludeCredentials` lists what
   * is already enrolled so a device cannot silently register itself twice and
   * leave two rows for one authenticator.
   */
  async beginRegistration(
    user: { id: UserId; username: string },
  ): Promise<Record<string, unknown>> {
    const challenge = await this.#issueChallenge("register", user.id);
    const existing = await this.#credentials.listForUser(user.id);

    return {
      challenge,
      rp: { id: this.#expected.rpId, name: "Job Radar" },
      user: {
        // The user handle is an opaque identifier, not a secret and not PII.
        // Every binary field in these options travels as base64url and the
        // client decodes it — one encoding for the whole boundary.
        id: userHandleFor(user.id),
        name: user.username,
        displayName: user.username,
      },
      pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      timeout: CHALLENGE_LIFETIME_MS,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      excludeCredentials: existing.map((credential) => ({
        type: "public-key",
        id: credential.credentialId,
        ...(credential.transports.length > 0 ? { transports: credential.transports } : {}),
      })),
    };
  }

  async finishRegistration(
    user: { id: UserId },
    label: string,
    response: RegistrationResponse,
  ): Promise<Credential> {
    const verified = await verifyRegistration(response, this.#expected);

    const consumed = await this.#challenges.consume(
      verified.challenge,
      "register",
      this.#clock.now(),
    );
    if (consumed === null) {
      throw new WebAuthnError("That registration has expired or was already completed. Try again.");
    }
    // The challenge was issued to a session; the response must come back to the
    // same one. Otherwise one account's challenge could enrol another's key.
    if (consumed.userId !== user.id) {
      throw new WebAuthnError("That registration was started by a different session.");
    }

    if (await this.#credentials.findByCredentialId(verified.credentialId) !== null) {
      throw new WebAuthnError("This device is already registered.");
    }

    const trimmed = label.trim();
    return await this.#credentials.create({
      userId: user.id,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      transports: (response.transports ?? []).filter((t) => typeof t === "string" && t.length < 32),
      aaguid: verified.aaguid,
      backedUp: verified.backedUp,
      label: trimmed === "" ? "Passkey" : trimmed.slice(0, 60),
    });
  }

  /**
   * Options for `navigator.credentials.get`. No `allowCredentials`: the
   * credential is discoverable, so the browser offers what it holds for this
   * site and we never have to publish a list of registered credential ids to an
   * unauthenticated caller.
   */
  async beginAuthentication(): Promise<Record<string, unknown>> {
    const challenge = await this.#issueChallenge("authenticate", null);
    return {
      challenge,
      rpId: this.#expected.rpId,
      timeout: CHALLENGE_LIFETIME_MS,
      userVerification: "required",
    };
  }

  /** Verify a login ceremony and report whose credential it was. */
  async finishAuthentication(response: AuthenticationResponse): Promise<Credential> {
    const credential = await this.#credentials.findByCredentialId(response.credentialId);
    if (credential === null) {
      throw new WebAuthnError("That passkey is not registered here.");
    }

    // The authenticator reports which user handle it stored. When it does, it
    // must be the one we wrote at registration.
    if (
      typeof response.userHandle === "string" && response.userHandle !== "" &&
      response.userHandle !== userHandleFor(credential.userId)
    ) {
      throw new WebAuthnError("That passkey belongs to a different account.");
    }

    const verified = await verifyAuthentication(response, {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      signCount: credential.signCount,
    }, this.#expected);

    const now = this.#clock.now();
    const consumed = await this.#challenges.consume(verified.challenge, "authenticate", now);
    if (consumed === null) {
      throw new WebAuthnError("That sign-in has expired or was already used. Try again.");
    }

    await this.#credentials.recordUse(credential.id, verified.signCount, now);
    return credential;
  }

  rename(id: string, label: string): Promise<void> {
    const trimmed = label.trim();
    return this.#credentials.rename(id, trimmed === "" ? "Passkey" : trimmed.slice(0, 60));
  }

  remove(id: string): Promise<void> {
    return this.#credentials.remove(id);
  }

  purgeExpiredChallenges(): Promise<number> {
    return this.#challenges.deleteExpired(this.#clock.now());
  }
}

/**
 * The relying party id and origin come from the configured base URL — never
 * from the request, which the client controls. A mismatch here is the whole
 * defence against a credential being usable from another site.
 */
export function expectedOriginFrom(baseUrl: string): ExpectedOrigin {
  const url = new URL(baseUrl);
  return { rpId: url.hostname, origin: url.origin };
}

/** The opaque handle the authenticator stores alongside a discoverable credential. */
export function userHandleFor(userId: UserId): string {
  return base64Url(new TextEncoder().encode(userId));
}
