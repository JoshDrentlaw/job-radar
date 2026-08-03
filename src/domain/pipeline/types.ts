/**
 * Pipeline domain (§9): what was sent where, when, with which variant, and
 * what happened.
 *
 * The honesty rule that shapes this context: a status is either something the
 * user observed or something a rule computed from elapsed time. It is never an
 * inference about what an employer is thinking. `ghosted` in particular means
 * "no activity for N days" and nothing more — naming that plainly is more
 * useful than leaving stale rows in `sent` forever.
 */

import type { ApplicationId, PostingId, VariantId } from "@platform/ids.ts";

export const APPLICATION_STATUSES = [
  "drafting",
  "sent",
  "acknowledged",
  "screening",
  "interviewing",
  "rejected",
  "ghosted",
  "withdrawn",
  "offer",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

/** Statuses that end the story. A closed application is not swept for ghosting. */
export const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "rejected",
  "withdrawn",
  "offer",
]);

/** Statuses where silence is meaningful — the ghosting sweep considers these. */
export const AWAITING_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "sent",
  "acknowledged",
  "screening",
  "interviewing",
]);

export type EventKind = "created" | "status_changed" | "note" | "sent";
export type EventSource = "user" | "rule";

export interface ApplicationEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly fromStatus: ApplicationStatus | null;
  readonly toStatus: ApplicationStatus | null;
  readonly detail: string;
  readonly source: EventSource;
  readonly at: Date;
}

export interface Application {
  readonly id: ApplicationId;
  readonly postingId: PostingId;
  readonly variantId: VariantId;
  readonly coverLetterId?: string;
  /** Denormalized at creation so the record reads correctly if the posting goes. */
  readonly postingTitle: string;
  readonly companyName: string;
  readonly applyUrl: string;
  readonly status: ApplicationStatus;
  readonly sentAt?: Date;
  readonly lastActivityAt: Date;
  readonly notes: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly events: readonly ApplicationEvent[];
}

export interface ApplicationSummary {
  readonly id: ApplicationId;
  readonly postingId: PostingId;
  readonly postingTitle: string;
  readonly companyName: string;
  readonly status: ApplicationStatus;
  readonly sentAt?: Date;
  readonly lastActivityAt: Date;
  readonly eventCount: number;
}

export class DuplicateApplicationError extends Error {
  override readonly name = "DuplicateApplicationError";
  constructor(postingTitle: string) {
    super(
      `There is already an open application for "${postingTitle}". Withdraw it before ` +
        `starting another, so the history stays readable.`,
    );
  }
}

export class VariantNotFrozenError extends Error {
  override readonly name = "VariantNotFrozenError";
  constructor() {
    super(
      "An application freezes the variant it was sent with (§9), so the document that was " +
        "actually sent stays renderable. Freezing failed.",
    );
  }
}

/**
 * The ghosting rule (§9). Configurable because "how long is silence meaningful"
 * is a judgement about a particular job search, not a constant.
 */
export const GHOST_AFTER_DAYS_SETTING = "pipeline.ghost_after_days";
export const DEFAULT_GHOST_AFTER_DAYS = 21;

export function ghostCutoff(now: Date, afterDays: number): Date {
  return new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000);
}

/**
 * Whether elapsed silence has made this application stale. Deliberately a pure
 * function of stored state and the clock: no inference about the employer, and
 * any new activity moves it back out on the next edit.
 */
export function shouldGhost(
  application: Pick<Application, "status" | "lastActivityAt">,
  now: Date,
  afterDays: number,
): boolean {
  if (!AWAITING_STATUSES.has(application.status)) return false;
  return application.lastActivityAt <= ghostCutoff(now, afterDays);
}

export interface NewApplication {
  readonly postingId: PostingId;
  readonly variantId: VariantId;
  readonly coverLetterId?: string;
  readonly postingTitle: string;
  readonly companyName: string;
  readonly applyUrl: string;
}

export interface ApplicationQuery {
  readonly status?: ApplicationStatus;
  readonly includeClosed?: boolean;
}

export interface ApplicationRepo {
  list(query?: ApplicationQuery): Promise<ApplicationSummary[]>;
  get(id: ApplicationId): Promise<Application | null>;
  /** Throws DuplicateApplicationError when an open one already exists. */
  create(input: NewApplication): Promise<Application>;
  /** Records the transition on the timeline; refuses a no-op change. */
  changeStatus(
    id: ApplicationId,
    to: ApplicationStatus,
    opts: { detail?: string; source?: EventSource; at: Date },
  ): Promise<void>;
  setNotes(id: ApplicationId, notes: string, at: Date): Promise<void>;
  addEvent(id: ApplicationId, detail: string, at: Date): Promise<void>;
  remove(id: ApplicationId): Promise<void>;
  /** Open applications whose silence has passed the cutoff. */
  findStale(cutoff: Date): Promise<ApplicationSummary[]>;
  countByStatus(): Promise<Map<ApplicationStatus, number>>;
}
