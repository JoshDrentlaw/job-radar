/**
 * Environment configuration. Secrets come from the environment — never the
 * database, never the repo (§11).
 *
 * Every value is read once at startup and validated. A missing or malformed
 * setting is a startup failure, not a surprise at request time.
 */

export type AppEnv = "development" | "production";

export interface Config {
  readonly env: AppEnv;
  readonly host: string;
  readonly port: number;
  /** Public origin the app is served from. Used for redirects and the CSP. */
  readonly baseUrl: string;
  /** Advertised in the outbound User-Agent so board owners can reach a human (§15). */
  readonly contactUrl: string;
  readonly databaseUrl: string;
  /**
   * Absent when embeddings are not configured; the matching pages say so
   * rather than failing. Set VOYAGE_API_KEY to enable.
   */
  readonly voyageApiKey?: string;
  /**
   * Recorded with every vector (§7). Changing it is the explicit act that
   * re-embeds the corpus and rescores everything — never change it casually.
   */
  readonly embeddingModel: string;
  /** Absent when tailoring is not configured; the dossier pages say so. */
  readonly anthropicApiKey?: string;
  /** Recorded on every tailoring run, so a proposal's provenance is inspectable. */
  readonly anthropicModel: string;
  readonly logLevel: LogLevel;
  /**
   * Whether to set `Secure` on the session cookie. Always true in production;
   * relaxed in development so the app is usable over plain http on localhost.
   */
  readonly secureCookies: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function required(source: EnvSource, key: string): string {
  const value = source(key);
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optional(source: EnvSource, key: string, fallback: string): string {
  const value = source(key);
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export type EnvSource = (key: string) => string | undefined;

const denoEnv: EnvSource = (key) => Deno.env.get(key);

/**
 * What a command-line tool needs, and deliberately nothing else.
 *
 * `migrate` and `seed-admin` touch the database and write logs. They have no
 * business reading an embedding key or an Anthropic key, and their permission
 * allowlists in `deno.json` say so — which means `loadConfig`, which reads
 * every setting the *server* needs, would fail in those tools at the first
 * `Deno.env.get` it is not permitted to make. It did, for as long as both
 * tasks existed; CI is what surfaced it.
 */
export interface ToolConfig {
  readonly env: AppEnv;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
}

export function loadToolConfig(source: EnvSource = denoEnv): ToolConfig {
  const env = readEnv(source);
  return { env, databaseUrl: readDatabaseUrl(source), logLevel: readLogLevel(source, env) };
}

function readEnv(source: EnvSource): AppEnv {
  const rawEnv = optional(source, "APP_ENV", "development");
  if (rawEnv !== "development" && rawEnv !== "production") {
    throw new ConfigError(`APP_ENV must be "development" or "production", got: ${rawEnv}`);
  }
  return rawEnv;
}

function readDatabaseUrl(source: EnvSource): string {
  const databaseUrl = required(source, "DATABASE_URL");
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }
  return databaseUrl;
}

function readLogLevel(source: EnvSource, env: AppEnv): LogLevel {
  const rawLogLevel = optional(source, "LOG_LEVEL", env === "production" ? "info" : "debug");
  if (!LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got: ${rawLogLevel}`);
  }
  return rawLogLevel as LogLevel;
}

/**
 * Build the full server config from an environment source. The source is
 * injectable so tests never touch the real process environment.
 */
export function loadConfig(source: EnvSource = denoEnv): Config {
  const rawEnv = readEnv(source);

  const rawPort = optional(source, "PORT", "8000");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer in 1..65535, got: ${rawPort}`);
  }

  const logLevel = readLogLevel(source, rawEnv);
  const databaseUrl = readDatabaseUrl(source);

  const baseUrl = optional(source, "APP_BASE_URL", `http://127.0.0.1:${port}`);
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new ConfigError(`APP_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (rawEnv === "production" && parsedBase.protocol !== "https:") {
    throw new ConfigError("APP_BASE_URL must be https:// in production");
  }

  const contactUrl = optional(
    source,
    "CONTACT_URL",
    "https://github.com/JoshDrentlaw/job-radar",
  );

  const voyageApiKey = source("VOYAGE_API_KEY")?.trim() ?? "";
  const anthropicApiKey = source("ANTHROPIC_API_KEY")?.trim() ?? "";

  return {
    env: rawEnv,
    host: optional(source, "HOST", "127.0.0.1"),
    port,
    baseUrl: parsedBase.origin,
    contactUrl,
    databaseUrl,
    ...(voyageApiKey !== "" ? { voyageApiKey } : {}),
    embeddingModel: optional(source, "EMBEDDING_MODEL", "voyage-3.5"),
    ...(anthropicApiKey !== "" ? { anthropicApiKey } : {}),
    anthropicModel: optional(source, "ANTHROPIC_MODEL", "claude-opus-5"),
    logLevel,
    secureCookies: rawEnv === "production",
  };
}
