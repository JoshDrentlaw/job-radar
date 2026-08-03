import type { Sql } from "@platform/db.ts";
import { newVariantId, type PostingId, type VariantId } from "@platform/ids.ts";
import {
  type ResumeVariant,
  type VariantFactEntry,
  VariantFrozenError,
  type VariantRepo,
  type VariantSummary,
} from "@domain/dossier/types.ts";

interface VariantRow {
  id: string;
  name: string;
  parent_variant_id: string | null;
  target_posting_id: string | null;
  frozen: boolean;
  created_at: Date;
  updated_at: Date;
}

interface EntryRow {
  fact_id: string;
  position: number;
  rewritten_text: string | null;
}

function toVariant(row: VariantRow, entries: EntryRow[]): ResumeVariant {
  return {
    id: row.id as VariantId,
    name: row.name,
    frozen: row.frozen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entries: entries.map((entry) => ({
      factId: entry.fact_id as VariantFactEntry["factId"],
      position: Number(entry.position),
      ...(entry.rewritten_text !== null ? { rewrittenText: entry.rewritten_text } : {}),
    })),
    ...(row.parent_variant_id !== null
      ? { parentVariantId: row.parent_variant_id as VariantId }
      : {}),
    ...(row.target_posting_id !== null
      ? { targetPostingId: row.target_posting_id as PostingId }
      : {}),
  };
}

const COLUMNS = "id, name, parent_variant_id, target_posting_id, frozen, created_at, updated_at";

export class PostgresVariantRepo implements VariantRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(): Promise<VariantSummary[]> {
    const rows = await this.#sql<
      (VariantRow & { fact_count: string; rewrite_count: string })[]
    >`
      SELECT ${this.#sql.unsafe(COLUMNS)},
             (SELECT count(*) FROM dossier.variant_facts vf
              WHERE vf.variant_id = v.id)::text AS fact_count,
             (SELECT count(*) FROM dossier.variant_facts vf
              WHERE vf.variant_id = v.id AND vf.rewritten_text IS NOT NULL)::text AS rewrite_count
      FROM dossier.variants v
      ORDER BY updated_at DESC
    `;
    return rows.map((row) => ({
      id: row.id as VariantId,
      name: row.name,
      factCount: Number(row.fact_count),
      rewriteCount: Number(row.rewrite_count),
      frozen: row.frozen,
      updatedAt: row.updated_at,
      ...(row.target_posting_id !== null
        ? { targetPostingId: row.target_posting_id as PostingId }
        : {}),
    }));
  }

  async get(id: VariantId): Promise<ResumeVariant | null> {
    const rows = await this.#sql<VariantRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM dossier.variants v WHERE id = ${id}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const entries = await this.#sql<EntryRow[]>`
      SELECT fact_id, position, rewritten_text
      FROM dossier.variant_facts WHERE variant_id = ${id}
      ORDER BY position
    `;
    return toVariant(row, entries);
  }

  async create(input: {
    name: string;
    targetPostingId?: PostingId;
    parentVariantId?: VariantId;
    entries?: readonly VariantFactEntry[];
  }): Promise<ResumeVariant> {
    const id = newVariantId();
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<VariantRow[]>`
        INSERT INTO dossier.variants (id, name, parent_variant_id, target_posting_id)
        VALUES (${id}, ${input.name}, ${input.parentVariantId ?? null},
                ${input.targetPostingId ?? null})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      const entries = input.entries ?? [];
      for (const entry of entries) {
        await tx`
          INSERT INTO dossier.variant_facts (variant_id, fact_id, position, rewritten_text)
          VALUES (${id}, ${entry.factId}, ${entry.position}, ${entry.rewrittenText ?? null})
        `;
      }
      return toVariant(
        rows[0]!,
        entries.map((entry) => ({
          fact_id: entry.factId as string,
          position: entry.position,
          rewritten_text: entry.rewrittenText ?? null,
        })),
      );
    });
  }

  async rename(id: VariantId, name: string): Promise<void> {
    await this.#assertMutable(id);
    await this.#sql`
      UPDATE dossier.variants SET name = ${name}, updated_at = now()
      WHERE id = ${id} AND NOT frozen
    `;
  }

  async setEntries(id: VariantId, entries: readonly VariantFactEntry[]): Promise<void> {
    await this.#assertMutable(id);
    await this.#sql.begin(async (tx) => {
      await tx`DELETE FROM dossier.variant_facts WHERE variant_id = ${id}`;
      for (const entry of entries) {
        await tx`
          INSERT INTO dossier.variant_facts (variant_id, fact_id, position, rewritten_text)
          VALUES (${id}, ${entry.factId}, ${entry.position}, ${entry.rewrittenText ?? null})
        `;
      }
      await tx`UPDATE dossier.variants SET updated_at = now() WHERE id = ${id}`;
    });
  }

  async freeze(id: VariantId): Promise<void> {
    await this.#sql`
      UPDATE dossier.variants SET frozen = true, updated_at = now() WHERE id = ${id}
    `;
  }

  async remove(id: VariantId): Promise<void> {
    // Frozen variants are history (§8); entries cascade for the rest.
    await this.#assertMutable(id);
    await this.#sql`DELETE FROM dossier.variants WHERE id = ${id} AND NOT frozen`;
  }

  /**
   * The loud half of immutability: mutating a frozen variant is an error, not
   * a no-op. The `AND NOT frozen` guards on the writes are the quiet half,
   * covering the freeze-races this check cannot.
   */
  async #assertMutable(id: VariantId): Promise<void> {
    const rows = await this.#sql<{ name: string; frozen: boolean }[]>`
      SELECT name, frozen FROM dossier.variants WHERE id = ${id}
    `;
    const row = rows[0];
    if (row !== undefined && row.frozen) throw new VariantFrozenError(row.name);
  }
}
