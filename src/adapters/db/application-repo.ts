import type { Sql } from "@platform/db.ts";
import type { ApplicationId, PostingId, VariantId } from "@platform/ids.ts";
import {
  type Application,
  type ApplicationEvent,
  type ApplicationQuery,
  type ApplicationRepo,
  type ApplicationStatus,
  type ApplicationSummary,
  AWAITING_STATUSES,
  DuplicateApplicationError,
  type EventKind,
  type EventSource,
  type NewApplication,
  TERMINAL_STATUSES,
} from "@domain/pipeline/types.ts";

interface ApplicationRow {
  id: string;
  posting_id: string;
  variant_id: string;
  cover_letter_id: string | null;
  posting_title: string;
  company_name: string;
  apply_url: string;
  status: string;
  sent_at: Date | null;
  last_activity_at: Date;
  notes: string;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  detail: string;
  source: string;
  at: Date;
}

function toEvent(row: EventRow): ApplicationEvent {
  return {
    id: row.id,
    kind: row.kind as EventKind,
    fromStatus: row.from_status as ApplicationStatus | null,
    toStatus: row.to_status as ApplicationStatus | null,
    detail: row.detail,
    source: row.source as EventSource,
    at: row.at,
  };
}

function toApplication(row: ApplicationRow, events: ApplicationEvent[]): Application {
  return {
    id: row.id as ApplicationId,
    postingId: row.posting_id as PostingId,
    variantId: row.variant_id as VariantId,
    postingTitle: row.posting_title,
    companyName: row.company_name,
    applyUrl: row.apply_url,
    status: row.status as ApplicationStatus,
    lastActivityAt: row.last_activity_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events,
    ...(row.cover_letter_id !== null ? { coverLetterId: row.cover_letter_id } : {}),
    ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
  };
}

const COLUMNS = `id, posting_id, variant_id, cover_letter_id, posting_title, company_name,
                 apply_url, status, sent_at, last_activity_at, notes, created_at, updated_at`;

/** Postgres unique_violation — the partial index on open applications. */
function isDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: string }).code === "23505";
}

export class PostgresApplicationRepo implements ApplicationRepo {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async list(query: ApplicationQuery = {}): Promise<ApplicationSummary[]> {
    const closed = [...TERMINAL_STATUSES] as string[];
    const rows = await this.#sql<
      (ApplicationRow & { event_count: string })[]
    >`
      SELECT ${this.#sql.unsafe(COLUMNS)},
             (SELECT count(*) FROM pipeline.application_events e
              WHERE e.application_id = a.id)::text AS event_count
      FROM pipeline.applications a
      WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
        AND (${query.includeClosed === true} OR status <> ALL(${closed}))
      ORDER BY last_activity_at DESC
    `;
    return rows.map((row) => ({
      id: row.id as ApplicationId,
      postingId: row.posting_id as PostingId,
      postingTitle: row.posting_title,
      companyName: row.company_name,
      status: row.status as ApplicationStatus,
      lastActivityAt: row.last_activity_at,
      eventCount: Number(row.event_count),
      ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
    }));
  }

  async get(id: ApplicationId): Promise<Application | null> {
    const rows = await this.#sql<ApplicationRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM pipeline.applications a WHERE id = ${id}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const events = await this.#sql<EventRow[]>`
      SELECT id, kind, from_status, to_status, detail, source, at
      FROM pipeline.application_events
      WHERE application_id = ${id}
      ORDER BY at DESC, id
    `;
    return toApplication(row, events.map(toEvent));
  }

  async create(input: NewApplication): Promise<Application> {
    try {
      return await this.#sql.begin(async (tx) => {
        const rows = await tx<ApplicationRow[]>`
          INSERT INTO pipeline.applications
            (posting_id, variant_id, cover_letter_id, posting_title, company_name, apply_url)
          VALUES (${input.postingId}, ${input.variantId}, ${input.coverLetterId ?? null},
                  ${input.postingTitle}, ${input.companyName}, ${input.applyUrl})
          RETURNING ${tx.unsafe(COLUMNS)}
        `;
        const row = rows[0]!;
        const events = await tx<EventRow[]>`
          INSERT INTO pipeline.application_events (application_id, kind, to_status, detail)
          VALUES (${row.id}, 'created', 'drafting', 'Application started.')
          RETURNING id, kind, from_status, to_status, detail, source, at
        `;
        return toApplication(row, events.map(toEvent));
      });
    } catch (error) {
      if (isDuplicate(error)) throw new DuplicateApplicationError(input.postingTitle);
      throw error;
    }
  }

  /**
   * Status changes are recorded, not just applied. A no-op change writes
   * nothing — a timeline of "sent → sent" is noise, not history.
   */
  async changeStatus(
    id: ApplicationId,
    to: ApplicationStatus,
    opts: { detail?: string; source?: EventSource; at: Date },
  ): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<{ status: string }[]>`
        SELECT status FROM pipeline.applications WHERE id = ${id} FOR UPDATE
      `;
      const current = rows[0]?.status as ApplicationStatus | undefined;
      if (current === undefined || current === to) return;

      const source = opts.source ?? "user";
      // A rule-set status is not activity; only a human observing something is.
      // Otherwise the sweep would keep resetting the very clock it reads.
      const touchesActivity = source === "user";

      await tx`
        UPDATE pipeline.applications
        SET status = ${to},
            sent_at = CASE WHEN ${to} = 'sent' AND sent_at IS NULL THEN ${opts.at} ELSE sent_at END,
            last_activity_at = CASE WHEN ${touchesActivity} THEN ${opts.at} ELSE last_activity_at END,
            updated_at = ${opts.at}
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO pipeline.application_events
          (application_id, kind, from_status, to_status, detail, source, at)
        VALUES (${id}, ${to === "sent" ? "sent" : "status_changed"}, ${current}, ${to},
                ${opts.detail ?? ""}, ${source}, ${opts.at})
      `;
    });
  }

  async setNotes(id: ApplicationId, notes: string, at: Date): Promise<void> {
    // Editing a note is not activity on the application — it is the user
    // writing something down, which says nothing about the employer.
    await this.#sql`
      UPDATE pipeline.applications SET notes = ${notes}, updated_at = ${at} WHERE id = ${id}
    `;
  }

  /** A logged observation: this is activity, and it un-ghosts a stale row. */
  async addEvent(id: ApplicationId, detail: string, at: Date): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`
        INSERT INTO pipeline.application_events (application_id, kind, detail, at)
        VALUES (${id}, 'note', ${detail}, ${at})
      `;
      await tx`
        UPDATE pipeline.applications
        SET last_activity_at = ${at}, updated_at = ${at}
        WHERE id = ${id}
      `;
    });
  }

  async remove(id: ApplicationId): Promise<void> {
    await this.#sql`DELETE FROM pipeline.applications WHERE id = ${id}`;
  }

  /**
   * The awaiting set comes from the domain rather than being spelled out here:
   * adding a status to it must not silently leave the sweep behind.
   */
  async findStale(cutoff: Date): Promise<ApplicationSummary[]> {
    const awaiting = [...AWAITING_STATUSES] as string[];
    const rows = await this.#sql<ApplicationRow[]>`
      SELECT ${this.#sql.unsafe(COLUMNS)} FROM pipeline.applications a
      WHERE status = ANY(${awaiting})
        AND last_activity_at <= ${cutoff}
      ORDER BY last_activity_at
    `;
    return rows.map((row) => ({
      id: row.id as ApplicationId,
      postingId: row.posting_id as PostingId,
      postingTitle: row.posting_title,
      companyName: row.company_name,
      status: row.status as ApplicationStatus,
      lastActivityAt: row.last_activity_at,
      eventCount: 0,
      ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
    }));
  }

  async countByStatus(): Promise<Map<ApplicationStatus, number>> {
    const rows = await this.#sql<{ status: string; count: string }[]>`
      SELECT status, count(*)::text AS count FROM pipeline.applications GROUP BY status
    `;
    return new Map(rows.map((r) => [r.status as ApplicationStatus, Number(r.count)]));
  }
}
