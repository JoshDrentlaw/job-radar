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
 * Build the config from an environment source. The source is injectable so
 * tests never touch the real process environment.
 */
export function loadConfig(source: EnvSource = denoEnv): Config {
  const rawEnv = optional(source, "APP_ENV", "development");
  if (rawEnv !== "development" && rawEnv !== "production") {
    throw new ConfigError(`APP_ENV must be "development" or "production", got: ${rawEnv}`);
  }

  const rawPort = optional(source, "PORT", "8000");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer in 1..65535, got: ${rawPort}`);
  }

  const rawLogLevel = optional(source, "LOG_LEVEL", rawEnv === "production" ? "info" : "debug");
  if (!LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got: ${rawLogLevel}`,
    );
  }

  const databaseUrl = required(source, "DATABASE_URL");
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }

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

  return {
    env: rawEnv,
    host: optional(source, "HOST", "127.0.0.1"),
    port,
    baseUrl: parsedBase.origin,
    contactUrl,
    databaseUrl,
    logLevel: rawLogLevel as LogLevel,
    secureCookies: rawEnv === "production",
  };
}
