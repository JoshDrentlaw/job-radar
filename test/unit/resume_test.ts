import { assert, assertEquals, assertThrows } from "@std/assert";
import type { FactId, VariantId } from "@platform/ids.ts";
import type { Identity, ResumeFact, ResumeVariant } from "@domain/dossier/types.ts";
import {
  assembleResume,
  contactLine,
  formatDateRange,
  ResumeAssemblyError,
} from "@domain/dossier/resume.ts";

const IDENTITY: Identity = {
  name: "Josh Example",
  email: "josh@example.test",
  location: "Duluth, MN",
  links: ["github.com/example"],
};

function fact(
  partial:
    & Omit<Partial<ResumeFact>, "id" | "parentId">
    & { id: string; parentId?: string; kind: ResumeFact["kind"]; text: string },
): ResumeFact {
  const { id, parentId, ...rest } = partial;
  return {
    tags: [],
    active: true,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...rest,
    id: id as FactId,
    ...(parentId !== undefined ? { parentId: parentId as FactId } : {}),
  };
}

function variant(
  entries: Array<{ factId: string; position: number; rewrittenText?: string }>,
): ResumeVariant {
  return {
    id: "00000000-0000-4000-8000-000000000001" as VariantId,
    name: "test",
    entries: entries.map((e) => ({
      factId: e.factId as FactId,
      position: e.position,
      ...(e.rewrittenText !== undefined ? { rewrittenText: e.rewrittenText } : {}),
    })),
    frozen: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const FACTS: ResumeFact[] = [
  fact({ id: "f-summary", kind: "summary", text: "Programmer of fifteen years." }),
  fact({
    id: "f-role",
    kind: "role",
    text: "Programmer",
    organization: "Acme",
    startDate: new Date("2020-03-01T00:00:00Z"),
  }),
  fact({
    id: "f-b1",
    kind: "bullet",
    parentId: "f-role" as FactId,
    text: "Built the data pipeline.",
  }),
  fact({
    id: "f-b2",
    kind: "bullet",
    parentId: "f-role" as FactId,
    text: "Ran the Postgres fleet.",
  }),
  fact({ id: "f-skill", kind: "skill", text: "TypeScript" }),
  fact({ id: "f-skill2", kind: "skill", text: "Postgres" }),
];

Deno.test("assemble: sections form and variant order is authoritative", () => {
  const v = variant([
    { factId: "f-skill2", position: 0 },
    { factId: "f-summary", position: 1 },
    { factId: "f-role", position: 2 },
    { factId: "f-b2", position: 3 },
    { factId: "f-b1", position: 4 },
    { factId: "f-skill", position: 5 },
  ]);
  const { resume, warnings } = assembleResume(IDENTITY, FACTS, v);
  assertEquals(warnings, []);
  assertEquals(resume.sections.length, 3);

  const [summary, experience, skills] = [
    resume.sections[0]!,
    resume.sections[1]!,
    resume.sections[2]!,
  ];
  assertEquals(summary, { kind: "summary", paragraphs: ["Programmer of fifteen years."] });
  assert(experience.kind === "experience");
  assertEquals(experience.entries[0]!.title, "Programmer");
  assertEquals(experience.entries[0]!.organization, "Acme");
  assertEquals(experience.entries[0]!.dates, "Mar 2020 – Present");
  // Bullet order follows the variant, not the fact set.
  assertEquals(experience.entries[0]!.bullets, [
    "Ran the Postgres fleet.",
    "Built the data pipeline.",
  ]);
  assert(skills.kind === "skills");
  assertEquals(skills.items, ["Postgres", "TypeScript"]);
});

Deno.test("assemble: rewrites replace text; empty rewrites fall back to canonical", () => {
  const v = variant([
    { factId: "f-role", position: 0 },
    { factId: "f-b1", position: 1, rewrittenText: "Designed and ran the ingest pipeline." },
    { factId: "f-b2", position: 2, rewrittenText: "   " },
  ]);
  const { resume } = assembleResume(IDENTITY, FACTS, v);
  const experience = resume.sections[0]!;
  assert(experience.kind === "experience");
  assertEquals(experience.entries[0]!.bullets, [
    "Designed and ran the ingest pipeline.",
    "Ran the Postgres fleet.",
  ]);
});

Deno.test("assemble: a bullet without its parent selected warns and is not rendered", () => {
  const v = variant([{ factId: "f-b1", position: 0 }]);
  const { resume, warnings } = assembleResume(IDENTITY, FACTS, v);
  assertEquals(resume.sections, []);
  assertEquals(warnings, [{ factId: "f-b1" as FactId, reason: "parent-not-selected" }]);
});

Deno.test("assemble: citing a nonexistent fact is an error, not an omission", () => {
  const v = variant([{ factId: "f-ghost", position: 0 }]);
  assertThrows(() => assembleResume(IDENTITY, FACTS, v), ResumeAssemblyError);
});

Deno.test("assemble: a retired fact still renders when a variant cites it", () => {
  const retired = FACTS.map((f) => f.id === ("f-skill" as FactId) ? { ...f, active: false } : f);
  const v = variant([{ factId: "f-skill", position: 0 }]);
  const { resume } = assembleResume(IDENTITY, retired, v);
  assert(resume.sections[0]!.kind === "skills");
});

Deno.test("formatDateRange covers open and closed ranges in UTC", () => {
  assertEquals(formatDateRange(undefined, undefined), undefined);
  assertEquals(
    formatDateRange(new Date("2020-03-01T00:00:00Z"), new Date("2023-11-01T00:00:00Z")),
    "Mar 2020 – Nov 2023",
  );
  assertEquals(formatDateRange(new Date("2020-12-01T00:00:00Z")), "Dec 2020 – Present");
});

Deno.test("contactLine joins only what identity provides, in fixed order", () => {
  assertEquals(
    contactLine(IDENTITY),
    "Duluth, MN  ·  josh@example.test  ·  github.com/example",
  );
  assertEquals(contactLine({ name: "X", links: [] }), "");
});
