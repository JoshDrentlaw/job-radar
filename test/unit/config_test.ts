/**
 * What each entry point is allowed to read.
 *
 * `deno.json` gives every task an explicit `--allow-env` list, and Deno throws
 * `NotCapable` on a read outside it. That is a *runtime* failure, so a config
 * loader that reaches for one key too many is invisible until the tool is run
 * — which is how `migrate` and `seed-admin` shipped broken: both called the
 * full `loadConfig`, which reads VOYAGE_API_KEY, and neither task was
 * permitted to.
 *
 * The fake source below is that permission boundary, made testable: it throws
 * on any key outside the allowlist, exactly as Deno does.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { type EnvSource, loadConfig, loadToolConfig } from "@platform/config.ts";

class NotPermitted extends Error {}

/** Mirrors a `--allow-env` allowlist, including Deno's `PREFIX*` wildcards. */
function permitted(allowlist: readonly string[], values: Record<string, string>): EnvSource {
  const allows = (key: string) =>
    allowlist.some((entry) =>
      entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : entry === key
    );
  return (key) => {
    if (!allows(key)) {
      throw new NotPermitted(
        `Requires env access to "${key}", run again with the --allow-env flag`,
      );
    }
    return values[key];
  };
}

/** The lists as they appear in deno.json. Keep them in step. */
const MIGRATE_ALLOWLIST = ["DATABASE_URL", "APP_ENV", "LOG_LEVEL", "PG*"];
const SEED_ADMIN_ALLOWLIST = [...MIGRATE_ALLOWLIST, "ADMIN_USERNAME", "ADMIN_PASSWORD"];
const SERVER_ALLOWLIST = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "APP_ENV",
  "APP_BASE_URL",
  "CONTACT_URL",
  "LOG_LEVEL",
  "PG*",
  "VOYAGE_API_KEY",
  "EMBEDDING_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_LOG",
];

const DATABASE_URL = "postgres://u:p@127.0.0.1:5432/jobradar";

Deno.test("the migrate task can load its config with the permissions it is granted", () => {
  const config = loadToolConfig(permitted(MIGRATE_ALLOWLIST, { DATABASE_URL }));
  assertEquals(config.databaseUrl, DATABASE_URL);
  assertEquals(config.env, "development");
  assertEquals(config.logLevel, "debug");
});

Deno.test("the seed-admin task can too", () => {
  const config = loadToolConfig(
    permitted(SEED_ADMIN_ALLOWLIST, { DATABASE_URL, APP_ENV: "production" }),
  );
  assertEquals(config.env, "production");
  assertEquals(config.logLevel, "info", "production defaults quieter");
});

Deno.test("the full server config needs the server's permissions — and gets them", () => {
  const config = loadConfig(
    permitted(SERVER_ALLOWLIST, {
      DATABASE_URL,
      APP_ENV: "production",
      APP_BASE_URL: "https://jobs.example.com",
      VOYAGE_API_KEY: "vk-test",
    }),
  );
  assertEquals(config.baseUrl, "https://jobs.example.com");
  assertEquals(config.voyageApiKey, "vk-test");
  assertEquals(config.secureCookies, true);
});

Deno.test("the full config in a tool's permissions is exactly the shipped bug", () => {
  // The allowlist `migrate` actually shipped with. `loadConfig` got as far as
  // VOYAGE_API_KEY and died there, on every run, before touching the database.
  const AS_SHIPPED = [
    "DATABASE_URL",
    "HOST",
    "PORT",
    "APP_ENV",
    "APP_BASE_URL",
    "CONTACT_URL",
    "LOG_LEVEL",
    "PG*",
  ];
  assertThrows(
    () => loadConfig(permitted(AS_SHIPPED, { DATABASE_URL })),
    NotPermitted,
    "VOYAGE_API_KEY",
  );

  // And under today's tighter list it fails even sooner — the point being that
  // the full server config simply does not belong in a command-line tool.
  assertThrows(
    () => loadConfig(permitted(MIGRATE_ALLOWLIST, { DATABASE_URL })),
    NotPermitted,
  );
});

Deno.test("a tool never reaches for a credential, whatever is in the environment", () => {
  // Even where the keys exist and are readable, the narrow loader does not
  // read them — a migration tool has no business holding an API key.
  const seen: string[] = [];
  const spy: EnvSource = (key) => {
    seen.push(key);
    return key === "DATABASE_URL" ? DATABASE_URL : undefined;
  };
  loadToolConfig(spy);
  for (const secret of ["VOYAGE_API_KEY", "ANTHROPIC_API_KEY"]) {
    assertEquals(
      seen.includes(secret),
      false,
      `${secret} was read by a tool that does not need it`,
    );
  }
  assertEquals(seen.sort(), ["APP_ENV", "DATABASE_URL", "LOG_LEVEL"]);
});

Deno.test("validation still bites in the narrow loader", () => {
  assertThrows(
    () => loadToolConfig(permitted(MIGRATE_ALLOWLIST, {})),
    Error,
    "Missing required environment variable: DATABASE_URL",
  );
  assertThrows(
    () => loadToolConfig(permitted(MIGRATE_ALLOWLIST, { DATABASE_URL: "mysql://nope" })),
    Error,
    "must be a postgres://",
  );
  assertThrows(
    () => loadToolConfig(permitted(MIGRATE_ALLOWLIST, { DATABASE_URL, APP_ENV: "staging" })),
    Error,
    'APP_ENV must be "development" or "production"',
  );
});
