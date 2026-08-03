/**
 * Structured logging. Every operation in a collection cycle threads the same
 * run id (§15), so a failed board can be traced back through the whole run.
 */

import type { LogLevel } from "./config.ts";

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps every record with additional fields. */
  with(fields: LogFields): Logger;
}

export type Sink = (line: string) => void;

/** Errors do not survive JSON.stringify; unwrap them into something readable. */
function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function normalizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) out[key] = normalize(value);
  return out;
}

export function createLogger(
  level: LogLevel,
  base: LogFields = {},
  sink: Sink = (line) => console.log(line),
): Logger {
  const threshold = SEVERITY[level];

  const emit = (recordLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (SEVERITY[recordLevel] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: recordLevel,
      msg,
      ...normalizeFields(base),
      ...(fields ? normalizeFields(fields) : {}),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    with: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

/** A logger that discards everything. For tests that do not assert on output. */
export const nullLogger: Logger = createLogger("error", {}, () => {});

export function newRunId(): string {
  return crypto.randomUUID();
}
