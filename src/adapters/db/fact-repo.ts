import type { Sql } from "@platform/db.ts";
import { type FactId, newFactId } from "@platform/ids.ts";
import {
  type FactInput,
  FactInUseError,
  type FactKind,
  type FactRepo,
  type ResumeFact,
} from "@domain/dossier/types.ts";

interface FactRow {
  id: string;
  kind: string;
  parent_id: string | null;
  text: string;
  tags: string[];
  start_date: Date | null;
  end_date: Date | null;
  organization: string | null;
  active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

function toFact(row: FactRow): ResumeFact {
  return {
    id: row.id as FactId,
    kind: row.kind as FactKind,
    text: row.text,
    tags: row.tags,
    active: row.active,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.parent_id !== null ? { parentId: row.parent_id as FactId } : {}),
    ...(row.start_date !== null ? { startDate: row.start_date } : {}),
    ...(row.end_date !== null ? { endDate: row.end_date } : {}),
    ...(row.organization !== null ? { organization: row.organization } : {}),
  };
}

/** Postgres foreign_key_violation — a variant still cites the fact. */
function isRestricted(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: string }).code === "23503";
}

const COLUMNS = `id, kind, parent_id, text, tags, start_date, end_date, organization,
                 active, sort_order, created_at, updated_at`;

export class PostgresFactRepo implements FactRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(): Promise<ResumeFact[]> {
    const rows = await this.#sql<FactRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM dossier.facts
      ORDER BY kind, parent_id NULLS FIRST, sort_order, created_at
    `;
    return rows.map(toFact);
  }

  async get(id: FactId): Promise<ResumeFact | null> {
    const rows = await this.#sql<FactRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM dossier.facts WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toFact(row) : null;
  }

  async create(input: FactInput): Promise<ResumeFact> {
    const id = newFactId();
    const rows = await this.#sql<FactRow[]>`
      INSERT INTO dossier.facts
        (id, kind, parent_id, text, tags, start_date, end_date, organization, sort_order)
      VALUES (
        ${id}, ${input.kind}, ${input.parentId ?? null}, ${input.text},
        ${(input.tags ?? []) as string[]}, ${input.startDate ?? null}, ${input.endDate ?? null},
        ${input.organization ?? null},
        (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM dossier.facts
         WHERE kind = ${input.kind}
           AND parent_id IS NOT DISTINCT FROM ${input.parentId ?? null})
      )
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    return toFact(rows[0]!);
  }

  async update(id: FactId, input: FactInput): Promise<ResumeFact | null> {
    const rows = await this.#sql<FactRow[]>`
      UPDATE dossier.facts SET
        kind         = ${input.kind},
        parent_id    = ${input.parentId ?? null},
        text         = ${input.text},
        tags         = ${(input.tags ?? []) as string[]},
        start_date   = ${input.startDate ?? null},
        end_date     = ${input.endDate ?? null},
        organization = ${input.organization ?? null},
        updated_at   = now()
      WHERE id = ${id}
      RETURNING ${this.#sql.unsafe(COLUMNS)}
    `;
    const row = rows[0];
    return row ? toFact(row) : null;
  }

  async setActive(id: FactId, active: boolean): Promise<void> {
    await this.#sql`
      UPDATE dossier.facts SET active = ${active}, updated_at = now() WHERE id = ${id}
    `;
  }

  async remove(id: FactId): Promise<void> {
    try {
      await this.#sql`DELETE FROM dossier.facts WHERE id = ${id}`;
    } catch (error) {
      if (isRestricted(error)) throw new FactInUseError();
      throw error;
    }
  }

  /**
   * Swap sort_order with the adjacent sibling. Done in one transaction against
   * fresh reads so two rapid clicks cannot interleave into duplicate orders.
   */
  async move(id: FactId, direction: "up" | "down"): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<FactRow[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM dossier.facts WHERE id = ${id}
      `;
      const fact = rows[0];
      if (fact === undefined) return;

      const neighbors = direction === "up"
        ? await tx<FactRow[]>`
          SELECT ${tx.unsafe(COLUMNS)} FROM dossier.facts
          WHERE kind = ${fact.kind}
            AND parent_id IS NOT DISTINCT FROM ${fact.parent_id}
            AND (sort_order, created_at) < (${fact.sort_order}, ${fact.created_at})
          ORDER BY sort_order DESC, created_at DESC LIMIT 1`
        : await tx<FactRow[]>`
          SELECT ${tx.unsafe(COLUMNS)} FROM dossier.facts
          WHERE kind = ${fact.kind}
            AND parent_id IS NOT DISTINCT FROM ${fact.parent_id}
            AND (sort_order, created_at) > (${fact.sort_order}, ${fact.created_at})
          ORDER BY sort_order ASC, created_at ASC LIMIT 1`;
      const neighbor = neighbors[0];
      if (neighbor === undefined) return;

      // created_at breaks sort_order ties, so equal orders must diverge
      // rather than swap into the same ambiguity.
      const factOrder = fact.sort_order === neighbor.sort_order
        ? neighbor.sort_order + (direction === "up" ? -1 : 1)
        : neighbor.sort_order;
      await tx`UPDATE dossier.facts SET sort_order = ${factOrder} WHERE id = ${fact.id}`;
      await tx`UPDATE dossier.facts SET sort_order = ${fact.sort_order} WHERE id = ${neighbor.id}`;
    });
  }
}
