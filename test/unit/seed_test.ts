import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildSeedRequest,
  MalformedSeedError,
  parseSeedResponse,
  SEED_SCHEMA,
} from "@domain/dossier/seed.ts";

/* ------------------------------------------------ schema ------------------ */

Deno.test("the schema forbids extra fields and requires every property", () => {
  assertEquals(SEED_SCHEMA.additionalProperties, false);
  const properties = SEED_SCHEMA.properties as {
    identity: { required: string[]; additionalProperties: boolean };
    facts: { items: { required: string[]; additionalProperties: boolean } };
  };
  assertEquals(properties.identity.additionalProperties, false);
  assertEquals(properties.identity.required, ["name", "email", "phone", "location", "links"]);
  assertEquals(properties.facts.items.additionalProperties, false);
  assertEquals(
    properties.facts.items.required,
    ["index", "kind", "parentIndex", "text", "organization", "tags", "startDate", "endDate"],
  );
});

Deno.test("the request has no cacheable prefix — there is nothing stable to cache across calls", () => {
  const request = buildSeedRequest("Jane Doe\nSenior Engineer at Acme");
  assertEquals(request.cacheablePrefix, undefined);
  assertEquals(request.schema, SEED_SCHEMA);
  assert(request.messages[0]!.content.includes("Jane Doe"));
});

/* ------------------------------------------------ parsing facts ----------- */

Deno.test("a well-formed extraction parses with dates, tags, and organization", () => {
  const json = {
    identity: null,
    facts: [{
      index: 0,
      kind: "role",
      parentIndex: null,
      text: "Senior Engineer at Acme",
      organization: "Acme",
      tags: ["Backend", "backend"],
      startDate: "2020-01",
      endDate: null,
    }],
  };
  const result = parseSeedResponse(json);
  assertEquals(result.facts.length, 1);
  const role = result.facts[0]!;
  assertEquals(role.kind, "role");
  assertEquals(role.organization, "Acme");
  assertEquals(role.tags, ["backend"]); // deduped and lowercased
  assertEquals(role.startDate, new Date("2020-01-01T00:00:00Z"));
  assertEquals(role.endDate, undefined);
  assertEquals(role.parentOf, undefined);
});

Deno.test("a bullet's parentIndex resolves to parentOf when it points at a role or project", () => {
  const json = {
    identity: null,
    facts: [
      {
        index: 0,
        kind: "role",
        parentIndex: null,
        text: "Engineer",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
      {
        index: 1,
        kind: "bullet",
        parentIndex: 0,
        text: "Shipped the thing",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
    ],
  };
  const result = parseSeedResponse(json);
  const bullet = result.facts.find((f) => f.kind === "bullet")!;
  assertEquals(bullet.parentOf, 0);
});

Deno.test("a parentIndex pointing at a non-parent kind is dropped, not trusted", () => {
  const json = {
    identity: null,
    facts: [
      {
        index: 0,
        kind: "skill",
        parentIndex: null,
        text: "TypeScript",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
      {
        index: 1,
        kind: "bullet",
        parentIndex: 0,
        text: "Orphaned bullet",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
    ],
  };
  const result = parseSeedResponse(json);
  const bullet = result.facts.find((f) => f.kind === "bullet")!;
  assertEquals(bullet.parentOf, undefined);
});

Deno.test("a parentIndex pointing at nothing is dropped, not trusted", () => {
  const json = {
    identity: null,
    facts: [
      {
        index: 1,
        kind: "bullet",
        parentIndex: 99,
        text: "Orphaned bullet",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
    ],
  };
  const bullet = parseSeedResponse(json).facts[0]!;
  assertEquals(bullet.parentOf, undefined);
});

Deno.test("an empty text extraction is dropped as noise, not kept as a blank candidate", () => {
  const json = {
    identity: null,
    facts: [
      {
        index: 0,
        kind: "skill",
        parentIndex: null,
        text: "   ",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
      {
        index: 1,
        kind: "skill",
        parentIndex: null,
        text: "Postgres",
        organization: null,
        tags: [],
        startDate: null,
        endDate: null,
      },
    ],
  };
  const result = parseSeedResponse(json);
  assertEquals(result.facts.length, 1);
  assertEquals(result.facts[0]!.text, "Postgres");
});

Deno.test("a vague date ('present') stays as no end date rather than being guessed", () => {
  const json = {
    identity: null,
    facts: [{
      index: 0,
      kind: "role",
      parentIndex: null,
      text: "Engineer",
      organization: null,
      tags: [],
      startDate: "2019-06",
      endDate: "present", // not a valid YYYY-MM — must not parse as a date
    }],
  };
  const role = parseSeedResponse(json).facts[0]!;
  assertEquals(role.endDate, undefined);
});

/* ------------------------------------------------ malformed responses ----- */

Deno.test("malformed responses are rejected, not coerced", () => {
  assertThrows(() => parseSeedResponse({}), MalformedSeedError);
  assertThrows(() => parseSeedResponse({ facts: "no" }), MalformedSeedError);
  assertThrows(
    () => parseSeedResponse({ facts: [{ kind: "role", text: "x" }] }), // no index
    MalformedSeedError,
  );
  assertThrows(
    () => parseSeedResponse({ facts: [{ index: 0, kind: "not-a-kind", text: "x" }] }),
    MalformedSeedError,
  );
});

/* ------------------------------------------------ identity -------------- */

Deno.test("identity is null when the model found nothing", () => {
  assertEquals(parseSeedResponse({ facts: [], identity: null }).identity, null);
  assertEquals(
    parseSeedResponse({
      facts: [],
      identity: { name: null, email: null, phone: null, location: null, links: [] },
    }).identity,
    null,
  );
});

Deno.test("identity carries whichever fields were actually found", () => {
  const result = parseSeedResponse({
    facts: [],
    identity: {
      name: "Jane Doe",
      email: null,
      phone: null,
      location: "Remote",
      links: ["https://example.com"],
    },
  });
  assertEquals(result.identity, {
    name: "Jane Doe",
    location: "Remote",
    links: ["https://example.com"],
  });
});
