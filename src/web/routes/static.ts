/**
 * Static assets.
 *
 * This is the one public prefix (see PUBLIC_PATHS): it serves the login page's
 * own stylesheet and holds no data. Requests are restricted to a flat directory
 * with a known extension map — no path segments, no traversal, no directory
 * listing, and nothing served that was not deliberately given a content type.
 */

import { Hono } from "hono";
import { join } from "@std/path";
import type { AppEnv } from "@web/types.ts";

const STATIC_DIR = "./static";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  // One script, and only one: the passkey ceremonies, which cannot be done
  // without client JS. Everything else on the site is server-rendered (§3).
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** A single flat filename. Anything with a separator or a dot-segment is out. */
const SAFE_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

export const staticRoutes = new Hono<AppEnv>();

staticRoutes.get("/static/:name", async (c) => {
  const name = c.req.param("name");
  if (!SAFE_NAME.test(name)) return c.notFound();

  const extension = name.slice(name.lastIndexOf("."));
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) return c.notFound();

  let body: Uint8Array;
  try {
    body = await Deno.readFile(join(STATIC_DIR, name));
  } catch {
    return c.notFound();
  }

  c.header("Content-Type", contentType);
  // Short cache: this is a single-user app and a stale stylesheet after a
  // deploy is more annoying than a revalidation request is expensive.
  c.header("Cache-Control", "public, max-age=300");
  return c.body(body as unknown as ArrayBuffer);
});
