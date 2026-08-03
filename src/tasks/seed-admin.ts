/**
 * One-off deploy task that creates the single admin account (§11).
 *
 * This exists precisely so that no registration route has to. Run it once at
 * deploy; it refuses to create a second account, and changing the existing
 * password requires saying so explicitly.
 *
 *   ADMIN_USERNAME=josh ADMIN_PASSWORD='...' deno task seed-admin
 *   ADMIN_USERNAME=josh ADMIN_PASSWORD='...' deno task seed-admin --reset
 */

import { loadConfig } from "@platform/config.ts";
import { createLogger } from "@platform/logger.ts";
import { closeDb, createDb } from "@platform/db.ts";
import { PostgresUserRepo } from "@adapters/db/user-repo.ts";
import { PostgresSessionRepo } from "@adapters/db/session-repo.ts";
import { assertAcceptablePassword, hashPassword, WeakPasswordError } from "@auth/password.ts";

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { component: "seed-admin" });
  const sql = createDb(config.databaseUrl, { max: 1 });
  const users = new PostgresUserRepo(sql);
  const reset = Deno.args.includes("--reset");

  try {
    const username = Deno.env.get("ADMIN_USERNAME")?.trim() ?? "";
    const password = Deno.env.get("ADMIN_PASSWORD") ?? "";

    if (username === "" || password === "") {
      console.error("Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.");
      return 1;
    }

    try {
      assertAcceptablePassword(password);
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }

    const existing = await users.findByUsername(username);
    const total = await users.count();

    if (existing !== null) {
      if (!reset) {
        console.error(
          `User "${username}" already exists. Pass --reset to set a new password for it.`,
        );
        return 1;
      }
      await users.updatePasswordHash(existing.id, await hashPassword(password));
      // A password reset usually means the old one is suspect; anything still
      // holding a session under it should not stay signed in.
      await new PostgresSessionRepo(sql).revokeAllForUser(existing.id, new Date());
      logger.info("admin password reset", { username });
      console.log(`Password updated for "${username}". All existing sessions were signed out.`);
      return 0;
    }

    // This app is single-user by design (§2). A second account would be a
    // feature nobody asked for arriving through the back door.
    if (total > 0) {
      console.error(
        `An account already exists and this application is single-user by design. ` +
          `Refusing to create "${username}".`,
      );
      return 1;
    }

    await users.create(username, await hashPassword(password));
    logger.info("admin created", { username });
    console.log(`Created admin account "${username}".`);
    return 0;
  } catch (error) {
    logger.error("seed-admin failed", { error });
    return 1;
  } finally {
    await closeDb(sql);
  }
}

Deno.exit(await main());
