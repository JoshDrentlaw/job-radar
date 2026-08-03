import type { Sql } from "@platform/db.ts";
import type { FactId, PostingId, VariantId } from "@platform/ids.ts";
import type { DocumentRepo, StoredDocument, StoredParagraph } from "@domain/dossier/proposals.ts";
import type { DraftParagraph } from "@domain/dossier/cover-letter.ts";

interface DocumentRow {
  id: string;
  kind: string;
  variant_id: string | null;
  posting_id: string | null;
  model: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface ParagraphRow {
  id: string;
  position: number;
  text: string;
  rationale: string;
  cited_fact_ids: string[] | null;
}

function toDocument(row: DocumentRow, paragraphs: StoredParagraph[]): StoredDocument {
  return {
    id: row.id,
    kind: row.kind as "cover_letter",
    variantId: row.variant_id as VariantId | null,
    postingId: row.posting_id as PostingId | null,
    model: row.model,
    status: row.status as "draft" | "accepted",
    paragraphs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DOC_COLUMNS = "id, kind, variant_id, posting_id, model, status, created_at, updated_at";

/** Citations are aggregated per paragraph so the UI can show them beside the text. */
const PARAGRAPH_SELECT = `
  p.id, p.position, p.text, p.rationale,
  array_remove(array_agg(c.fact_id), NULL)::text[] AS cited_fact_ids
`;

export class PostgresDocumentRepo implements DocumentRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async create(input: {
    variantId: VariantId | null;
    postingId: PostingId | null;
    model: string;
    paragraphs: readonly DraftParagraph[];
  }): Promise<StoredDocument> {
    return await this.#sql.begin(async (tx) => {
      const rows = await tx<DocumentRow[]>`
        INSERT INTO dossier.documents (kind, variant_id, posting_id, model, status)
        VALUES ('cover_letter', ${input.variantId}, ${input.postingId}, ${input.model}, 'draft')
        RETURNING ${tx.unsafe(DOC_COLUMNS)}
      `;
      const document = rows[0]!;
      const paragraphs: StoredParagraph[] = [];

      for (const [index, paragraph] of input.paragraphs.entries()) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO dossier.document_paragraphs (document_id, position, text, rationale)
          VALUES (${document.id}, ${index}, ${paragraph.text}, ${paragraph.rationale})
          RETURNING id
        `;
        const paragraphId = inserted[0]!.id;
        for (const factId of paragraph.citedFactIds) {
          await tx`
            INSERT INTO dossier.document_citations (paragraph_id, fact_id)
            VALUES (${paragraphId}, ${factId})
          `;
        }
        paragraphs.push({
          id: paragraphId,
          position: index,
          text: paragraph.text,
          rationale: paragraph.rationale,
          citedFactIds: paragraph.citedFactIds,
        });
      }
      return toDocument(document, paragraphs);
    });
  }

  async get(id: string): Promise<StoredDocument | null> {
    const rows = await this.#sql<DocumentRow[]>`
      SELECT ${this.#sql.unsafe(DOC_COLUMNS)} FROM dossier.documents WHERE id = ${id}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return toDocument(row, await this.#paragraphs(id));
  }

  async #paragraphs(documentId: string): Promise<StoredParagraph[]> {
    const rows = await this.#sql<ParagraphRow[]>`
      SELECT ${this.#sql.unsafe(PARAGRAPH_SELECT)}
      FROM dossier.document_paragraphs p
      LEFT JOIN dossier.document_citations c ON c.paragraph_id = p.id
      WHERE p.document_id = ${documentId}
      GROUP BY p.id, p.position, p.text, p.rationale
      ORDER BY p.position
    `;
    return rows.map((row) => ({
      id: row.id,
      position: Number(row.position),
      text: row.text,
      rationale: row.rationale,
      citedFactIds: (row.cited_fact_ids ?? []) as FactId[],
    }));
  }

  async listForVariant(variantId: VariantId): Promise<StoredDocument[]> {
    const rows = await this.#sql<DocumentRow[]>`
      SELECT ${this.#sql.unsafe(DOC_COLUMNS)} FROM dossier.documents
      WHERE variant_id = ${variantId}
      ORDER BY created_at DESC
    `;
    const documents: StoredDocument[] = [];
    for (const row of rows) documents.push(toDocument(row, await this.#paragraphs(row.id)));
    return documents;
  }

  async updateParagraph(paragraphId: string, text: string): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<{ document_id: string }[]>`
        UPDATE dossier.document_paragraphs SET text = ${text}
        WHERE id = ${paragraphId}
        RETURNING document_id
      `;
      const documentId = rows[0]?.document_id;
      if (documentId !== undefined) {
        await tx`UPDATE dossier.documents SET updated_at = now() WHERE id = ${documentId}`;
      }
    });
  }

  /** Citations cascade; the paragraph's claims leave with its text. */
  async removeParagraph(paragraphId: string): Promise<void> {
    await this.#sql`DELETE FROM dossier.document_paragraphs WHERE id = ${paragraphId}`;
  }

  async accept(id: string): Promise<void> {
    await this.#sql`
      UPDATE dossier.documents SET status = 'accepted', updated_at = now() WHERE id = ${id}
    `;
  }

  async remove(id: string): Promise<void> {
    await this.#sql`DELETE FROM dossier.documents WHERE id = ${id}`;
  }
}
