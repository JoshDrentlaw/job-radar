/**
 * Hono app assembly.
 *
 * Order matters here and is the security posture (§11): request context, then
 * security headers, then session resolution with default deny, then CSRF, and
 * only then any route. A route registered later cannot opt out of any of it.
 */

import { Hono } from "hono";
import { getConnInfo } from "hono/deno";
import type { Config } from "@platform/config.ts";
import { createLogger, type Logger, newRunId } from "@platform/logger.ts";
import { csrfMiddleware, securityHeaders, sessionMiddleware } from "@auth/middleware.ts";
import type { AppEnv } from "./types.ts";
import type { Services } from "./services.ts";
import { loginRoutes } from "./routes/login.tsx";
import { dashboardRoutes } from "./routes/dashboard.tsx";
import { boardRoutes } from "./routes/boards.tsx";
import { postingRoutes } from "./routes/postings.tsx";
import { profileRoutes } from "./routes/profile.tsx";
import { matchRoutes } from "./routes/matches.tsx";
import { tuningRoutes } from "./routes/tuning.tsx";
import { dossierRoutes } from "./routes/dossier.tsx";
import { variantRoutes } from "./routes/variants.tsx";
import { tailoringRoutes } from "./routes/tailoring.tsx";
import { letterRoutes } from "./routes/letters.tsx";
import { applicationRoutes } from "./routes/applications.tsx";
import { tokenRoutes } from "./routes/tokens.tsx";
import { apiRoutes, bearerAuth } from "./routes/api.ts";
import { coverageRoutes } from "./routes/coverage.tsx";
import { staticRoutes } from "./routes/static.ts";

export interface AppOptions {
  readonly config: Config;
  readonly services: Services;
  readonly logger?: Logger;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;

/** Loose but sufficient: rejects anything Postgres' inet type would choke on. */
export function isIpLike(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4 !== null) return v4.slice(1).every((octet) => Number(octet) <= 255);
  return value.includes(":") && IPV6_CHARS.test(value);
}

/**
 * The app binds to localhost and sits behind nginx (§13). With the standard
 * `proxy_add_x_forwarded_for`, nginx *appends* the address it actually talked
 * to, so the rightmost entry is the only one the proxy vouches for — everything
 * left of it arrived in the client's own header and is attacker-chosen. Taking
 * the leftmost would let a scanner rotate fake IPs past the login rate limiter.
 * The value also feeds `::inet` casts, so anything that does not look like an
 * IP is discarded rather than allowed to become a 500 at the database.
 */
export function clientIpOf(
  c: { req: { header(name: string): string | undefined; raw: Request } },
): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const last = forwarded.split(",").at(-1)?.trim();
    if (last !== undefined && isIpLike(last)) return last;
  }
  try {
    const address = getConnInfo(c as never).remote.address;
    if (address !== undefined && isIpLike(address)) return address;
  } catch {
    // Fall through: no connection info outside a real Deno.serve handler.
  }
  return "0.0.0.0";
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config, services } = options;
  const baseLogger = options.logger ?? createLogger(config.logLevel);
  const app = new Hono<AppEnv>();

  // Request context. The run id threads through every log line for this
  // request, and through a whole collection cycle when one starts here (§15).
  app.use("*", async (c, next) => {
    const requestId = newRunId();
    c.set("requestId", requestId);
    c.set("config", config);
    c.set("services", services);
    const ip = clientIpOf(c);
    c.set("clientIp", ip);
    c.set(
      "logger",
      baseLogger.with({ requestId, method: c.req.method, path: c.req.path }),
    );
    await next();
  });

  app.use("*", securityHeaders(config.env === "production"));

  // Health check is public and deliberately says nothing about internals.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // The n8n job routes carry their own bearer auth and are mounted ahead of
  // the session middleware (§11, §12). Two consequences, both deliberate: a
  // session cookie grants nothing here, and CSRF does not apply — it exists
  // because browsers attach cookies automatically, and nothing below reads one.
  // The guard is on the prefix, so a job route added later is covered too.
  app.use("/api/*", bearerAuth());
  app.route("/", apiRoutes);
  // Anything else under /api is not a job route and does not exist.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.use(
    "*",
    sessionMiddleware({
      resolveUser: (token) => services.sessions.resolve(token),
      secureCookies: config.secureCookies,
    }),
  );
  app.use("*", csrfMiddleware());

  app.route("/", staticRoutes);
  app.route("/", loginRoutes);
  app.route("/", dashboardRoutes);
  app.route("/", boardRoutes);
  app.route("/", postingRoutes);
  app.route("/", profileRoutes);
  app.route("/", matchRoutes);
  app.route("/", tuningRoutes);
  app.route("/", dossierRoutes);
  app.route("/", variantRoutes);
  app.route("/", tailoringRoutes);
  app.route("/", letterRoutes);
  app.route("/", applicationRoutes);
  app.route("/", tokenRoutes);
  app.route("/", coverageRoutes);

  app.notFound((c) => c.text("Not found.", 404));

  app.onError((error, c) => {
    c.get("logger").error("unhandled error", { error });
    // Never leak internals to the response; the detail is in the log.
    return c.text("Something went wrong.", 500);
  });

  return app;
}
