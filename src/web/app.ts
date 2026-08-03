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
import { coverageRoutes } from "./routes/coverage.tsx";
import { staticRoutes } from "./routes/static.ts";

export interface AppOptions {
  readonly config: Config;
  readonly services: Services;
  readonly logger?: Logger;
}

/**
 * The app binds to localhost and sits behind nginx (§13), so the proxy is the
 * only thing that can reach it and its X-Forwarded-For is the client address.
 * The leftmost entry is the original client.
 */
function clientIpOf(
  c: { req: { header(name: string): string | undefined; raw: Request } },
): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.trim() !== "") {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  try {
    return getConnInfo(c as never).remote.address ?? "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
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
  app.route("/", coverageRoutes);

  app.notFound((c) => c.text("Not found.", 404));

  app.onError((error, c) => {
    c.get("logger").error("unhandled error", { error });
    // Never leak internals to the response; the detail is in the log.
    return c.text("Something went wrong.", 500);
  });

  return app;
}
