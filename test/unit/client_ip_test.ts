import { assertEquals } from "@std/assert";
import { clientIpOf, isIpLike } from "@web/app.ts";

function fakeContext(headers: Record<string, string>) {
  const raw = new Request("http://localhost/", { headers });
  return {
    req: {
      header: (name: string) => raw.headers.get(name) ?? undefined,
      raw,
    },
  };
}

Deno.test("isIpLike accepts real addresses", () => {
  assertEquals(isIpLike("203.0.113.9"), true);
  assertEquals(isIpLike("127.0.0.1"), true);
  assertEquals(isIpLike("2001:db8::1"), true);
  assertEquals(isIpLike("::ffff:203.0.113.9"), true);
});

Deno.test("isIpLike rejects non-addresses", () => {
  assertEquals(isIpLike(""), false);
  assertEquals(isIpLike("evil"), false);
  assertEquals(isIpLike("300.1.1.1"), false);
  assertEquals(isIpLike("203.0.113.9, 10.0.0.1"), false);
  assertEquals(isIpLike("unknown"), false);
});

Deno.test("clientIpOf takes the rightmost X-Forwarded-For entry", () => {
  // Everything left of the last entry arrived in the client's own header and
  // is attacker-chosen; only the rightmost was appended by our proxy.
  const c = fakeContext({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" });
  assertEquals(clientIpOf(c), "203.0.113.9");
});

Deno.test("clientIpOf ignores a header that is not an address", () => {
  const c = fakeContext({ "x-forwarded-for": "sqlmap' OR 1=1" });
  assertEquals(clientIpOf(c), "0.0.0.0");
});

Deno.test("clientIpOf falls back without the header", () => {
  assertEquals(clientIpOf(fakeContext({})), "0.0.0.0");
});
