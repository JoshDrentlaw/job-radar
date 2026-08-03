import type { Sql } from "@platform/db.ts";
import type { UserId } from "@platform/ids.ts";
import type { StoredUser, User, UserRepo } from "@auth/types.ts";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: Date;
}

function toStored(row: UserRow): StoredUser {
  return {
    id: row.id as UserId,
    username: row.username,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };
}

export class PostgresUserRepo implements UserRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async findByUsername(username: string): Promise<StoredUser | null> {
    const rows = await this.#sql<UserRow[]>`
      SELECT id, username, password_hash, created_at
      FROM app.users
      WHERE username = ${username}
    `;
    const row = rows[0];
    return row ? toStored(row) : null;
  }

  async findById(id: UserId): Promise<User | null> {
    const rows = await this.#sql<UserRow[]>`
      SELECT id, username, password_hash, created_at
      FROM app.users
      WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;
    const { passwordHash: _ignored, ...user } = toStored(row);
    return user;
  }

  async create(username: string, passwordHash: string): Promise<User> {
    const rows = await this.#sql<UserRow[]>`
      INSERT INTO app.users (username, password_hash)
      VALUES (${username}, ${passwordHash})
      RETURNING id, username, password_hash, created_at
    `;
    const { passwordHash: _ignored, ...user } = toStored(rows[0]!);
    return user;
  }

  async updatePasswordHash(id: UserId, passwordHash: string): Promise<void> {
    await this.#sql`
      UPDATE app.users
      SET password_hash = ${passwordHash}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async count(): Promise<number> {
    const rows = await this.#sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM app.users`;
    return Number(rows[0]!.count);
  }
}
