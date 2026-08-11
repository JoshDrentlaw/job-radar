import type { Sql } from "@platform/db.ts";
import { type FacetId, newFacetId } from "@platform/ids.ts";
import {
  facetContentHash,
  type FacetInput,
  type FacetRepo,
  type ProfileFacet,
} from "@domain/discovery/matching.ts";

interface FacetRow {
  id: string;
  name: string;
  content: string;
  active: boolean;
  content_hash: string;
  created_at: Date;
  updated_at: Date;
}

function toFacet(row: FacetRow): ProfileFacet {
  return {
    id: row.id as FacetId,
    name: row.name,
    content: row.content,
    active: row.active,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, name, content, active, content_hash, created_at, updated_at";

export class PostgresFacetRepo implements FacetRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(): Promise<ProfileFacet[]> {
    const rows = await this.#sql<FacetRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.profile_facets ORDER BY name
    `;
    return rows.map(toFacet);
  }

  async get(id: FacetId): Promise<ProfileFacet | null> {
    const rows = await this.#sql<FacetRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM discovery.profile_facets WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toFacet(row) : null;
  }

  async upsert(input: FacetInput): Promise<ProfileFacet> {
    const id = input.id ?? newFacetId();
    const hash = await facetContentHash(input.content);
    const rows = await this.#sql<FacetRow[]>`
      INSERT INTO discovery.profile_facets (id, name, content, active, content_hash)
      VALUES (${id}, ${input.name}, ${input.content}, ${input.active ?? true}, ${hash})
      ON CONFLICT (id) DO UPDATE SET
        name         = EXCLUDED.name,
        content      = EXCLUDED.content,
        active       = EXCLUDED.active,
        content_hash = EXCLUDED.content_hash,
        updated_at   = now()
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    return toFacet(rows[0]!);
  }

  /** Chunks and matches follow by FK cascade. */
  async remove(id: FacetId): Promise<void> {
    await this.#sql`DELETE FROM discovery.profile_facets WHERE id = ${id}`;
  }

  async staleForModel(model: string, chunkerVersion: string): Promise<ProfileFacet[]> {
    const rows = await this.#sql<FacetRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)}
      FROM discovery.profile_facets f
      WHERE f.active
        AND NOT EXISTS (
          SELECT 1 FROM discovery.facet_chunks c
          WHERE c.facet_id = f.id
            AND c.model = ${model}
            AND c.chunker_version = ${chunkerVersion}
            AND c.content_hash = f.content_hash
        )
      ORDER BY f.name
    `;
    return rows.map(toFacet);
  }
}
