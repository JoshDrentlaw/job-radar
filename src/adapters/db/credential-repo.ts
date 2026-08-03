import type { Sql } from "@platform/db.ts";
import type { UserId } from "@platform/ids.ts";
import type {
  ChallengePurpose,
  ChallengeRepo,
  Credential,
  CredentialRepo,
  NewCredential,
} from "@auth/webauthn/service.ts";

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  sign_count: string;
  transports: string[];
  aaguid: string | null;
  backed_up: boolean;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

function toCredential(row: CredentialRow): Credential {
  return {
    id: row.id,
    userId: row.user_id as UserId,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    // bigint arrives as text from postgres.js; the counter is small in practice.
    signCount: Number(row.sign_count),
    transports: row.transports,
    aaguid: row.aaguid,
    backedUp: row.backed_up,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const COLUMNS = `id, user_id, credential_id, public_key, sign_count::text AS sign_count,
                 transports, aaguid, backed_up, label, created_at, last_used_at`;

export class PostgresCredentialRepo implements CredentialRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async listForUser(userId: UserId): Promise<Credential[]> {
    const rows = await this.#sql<CredentialRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM app.credentials
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows.map(toCredential);
  }

  async findByCredentialId(credentialId: string): Promise<Credential | null> {
    const rows = await this.#sql<CredentialRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM app.credentials
      WHERE credential_id = ${credentialId}
    `;
    const row = rows[0];
    return row ? toCredential(row) : null;
  }

  async create(credential: NewCredential): Promise<Credential> {
    const rows = await this.#sql<CredentialRow[]>`
      INSERT INTO app.credentials
        (user_id, credential_id, public_key, sign_count, transports, aaguid, backed_up, label)
      VALUES (${credential.userId}, ${credential.credentialId}, ${credential.publicKey},
              ${credential.signCount}, ${[...credential.transports] as string[]},
              ${credential.aaguid}, ${credential.backedUp}, ${credential.label})
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    return toCredential(rows[0]!);
  }

  /**
   * The counter only ever moves forward. Clamping here as well as checking in
   * the ceremony means a bug in one cannot walk it backwards.
   */
  async recordUse(id: string, signCount: number, at: Date): Promise<void> {
    await this.#sql`
      UPDATE app.credentials
      SET last_used_at = ${at}, sign_count = GREATEST(sign_count, ${signCount})
      WHERE id = ${id}
    `;
  }

  async rename(id: string, label: string): Promise<void> {
    await this.#sql`UPDATE app.credentials SET label = ${label} WHERE id = ${id}`;
  }

  async remove(id: string): Promise<void> {
    await this.#sql`DELETE FROM app.credentials WHERE id = ${id}`;
  }

  async countForUser(userId: UserId): Promise<number> {
    const rows = await this.#sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.credentials WHERE user_id = ${userId}
    `;
    return Number(rows[0]?.count ?? 0);
  }
}

export class PostgresChallengeRepo implements ChallengeRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async create(input: {
    challenge: string;
    purpose: ChallengePurpose;
    userId: UserId | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.#sql`
      INSERT INTO app.webauthn_challenges (challenge, purpose, user_id, created_at, expires_at)
      VALUES (${input.challenge}, ${input.purpose}, ${input.userId}, ${input.createdAt},
              ${input.expiresAt})
    `;
  }

  /**
   * One statement, on purpose. Reading the row and then marking it used would
   * let two concurrent requests both pass the read — which is precisely the
   * replay a challenge exists to prevent.
   */
  async consume(
    challenge: string,
    purpose: ChallengePurpose,
    at: Date,
  ): Promise<{ userId: UserId | null } | null> {
    const rows = await this.#sql<{ user_id: string | null }[]>`
      UPDATE app.webauthn_challenges
      SET consumed_at = ${at}
      WHERE challenge = ${challenge}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
        AND expires_at > ${at}
      RETURNING user_id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return { userId: row.user_id === null ? null : (row.user_id as UserId) };
  }

  async deleteExpired(before: Date): Promise<number> {
    const rows = await this.#sql<{ id: string }[]>`
      DELETE FROM app.webauthn_challenges WHERE expires_at < ${before} RETURNING challenge AS id
    `;
    return rows.length;
  }
}
