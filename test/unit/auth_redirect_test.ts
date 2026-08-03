import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { sessionMiddleware } from "@auth/middleware.ts";
import { safeRedirectTarget } from "@web/routes/login.tsx";
import type { AppEnv } from "@web/types.ts";

function appWithNoSession(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    sessionMiddleware({ resolveUser: () => Promise.resolve(null), secureCookies: false }),
  );
  app.get("/postings", (c) => c.text("never reached"));
  return app;
}

async function loginLocation(path: string): Promise<string> {
  const res = await appWithNoSession().request(path);
  assertEquals(res.status, 302);
  return res.headers.get("location") ?? "";
}

Deno.test("unauthenticated redirect preserves the query string exactly once", async () => {
  const location = await loginLocation("/postings?board=greenhouse%3Aacme&page=2");
  assertEquals(
    location,
    `/login?next=${encodeURIComponent("/postings?board=greenhouse%3Aacme&page=2")}`,
  );
});

Deno.test("unauthenticated redirect without a query has no stray separator", async () => {
  assertEquals(await loginLocation("/postings"), "/login?next=%2Fpostings");
});

Deno.test("redirect target round-trips through the login form", async () => {
  const location = await loginLocation("/postings?page=2");
  // searchParams.get decodes once, exactly as Hono's c.req.query() does.
  const next = new URL(location, "http://localhost").searchParams.get("next") ?? "";
  assertEquals(safeRedirectTarget(next), "/postings?page=2");
});

Deno.test("safeRedirectTarget refuses off-site destinations", () => {
  assertEquals(safeRedirectTarget("https://evil.example/"), "/");
  assertEquals(safeRedirectTarget("//evil.example/x"), "/");
  assertEquals(safeRedirectTarget("%2F%2Fevil.example"), "/");
  assertEquals(safeRedirectTarget("/ok/path"), "/ok/path");
});
