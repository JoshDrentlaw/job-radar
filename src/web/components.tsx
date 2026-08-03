/** @jsxImportSource hono/jsx */

/**
 * Shared presentation pieces.
 *
 * `Derived` and `Asserted` are the important ones. Every value the UI shows goes
 * through one of them, so the question "did the source say this, or did we work
 * it out?" is answered on screen without the reader having to ask (§5).
 */

import type { FC, PropsWithChildren } from "hono/jsx";
import type { Provenance, RemoteHint } from "@domain/discovery/types.ts";

/** A value taken verbatim from the feed. */
export const Asserted: FC<PropsWithChildren> = (props) => (
  <span class="asserted">{props.children}</span>
);

/**
 * A value this application computed. Rendered in a different hue, dotted, and
 * suffixed with a marker that reads aloud — a guess saying it is a guess.
 */
export const Derived: FC<PropsWithChildren<{ title?: string }>> = (props) => (
  <span class="derived" title={props.title ?? "Computed by Job Radar, not stated by the source"}>
    {props.children}
  </span>
);

export const FieldLegend: FC = () => (
  <p class="legend">
    <span>
      <span class="asserted">Plain text</span> is stated by the source.
    </span>
    <span>
      <span class="derived">This styling</span> marks a value Job Radar computed.
    </span>
  </p>
);

export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  // Stored UTC, displayed in a fixed readable form (§15). The browser's locale
  // is not available server-side, so ISO-ish beats a wrong guess at a locale.
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}

export function relativeAge(from: Date | null | undefined, now: Date): string {
  if (!from) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/**
 * The as-of panel. §5 requires that anything rendered can display its
 * provenance, so this is available on every posting view.
 */
export const ProvenanceLine: FC<{ provenance: Provenance }> = ({ provenance }) => (
  <dl class="provenance">
    <div>
      <dt>As of</dt>
      <dd>{formatDateTime(provenance.fetchedAt)}</dd>
    </div>
    <div>
      <dt>Source</dt>
      <dd>
        <a href={provenance.sourceUrl} rel="noreferrer noopener nofollow">{provenance.platform}</a>
      </dd>
    </div>
    <div>
      <dt>Adapter</dt>
      <dd>{provenance.adapterVersion}</dd>
    </div>
    <div>
      <dt>Content hash</dt>
      <dd>
        <code>{provenance.contentHash.slice(0, 12)}</code>
      </dd>
    </div>
  </dl>
);

export const RemoteHintChip: FC<{ hint: RemoteHint }> = ({ hint }) => {
  if (hint === "unknown") {
    return (
      <span class="chip guess" title="The location string did not state a work arrangement">
        arrangement not stated
      </span>
    );
  }
  return (
    <span class="chip guess" title="Inferred from the location string, not stated as a field">
      {hint}
    </span>
  );
};

export const StatusChip: FC<{ status: "ok" | "failed" | "never"; failures?: number }> = (
  { status, failures = 0 },
) => {
  if (status === "ok") return <span class="chip ok">ok</span>;
  if (status === "never") return <span class="chip muted">never fetched</span>;
  return (
    <span class="chip danger">
      failed{failures > 1 ? ` ×${failures}` : ""}
    </span>
  );
};

export const Notice: FC<PropsWithChildren<{ kind?: "ok" | "error" | "warn" }>> = (props) => (
  <p class={`notice${props.kind ? ` ${props.kind}` : ""}`}>{props.children}</p>
);

export const CsrfField: FC<{ token: string }> = ({ token }) => (
  <input type="hidden" name="_csrf" value={token} />
);

export const Metric: FC<{ label: string; value: string | number; hint?: string }> = (props) => (
  <div class="metric" {...(props.hint ? { title: props.hint } : {})}>
    <div class="metric-value">{props.value}</div>
    <div class="metric-label">{props.label}</div>
  </div>
);
