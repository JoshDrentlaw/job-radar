import { assert, assertEquals } from "@std/assert";
import { FixedClock } from "@platform/clock.ts";
import {
  APPLICATION_STATUSES,
  AWAITING_STATUSES,
  DEFAULT_GHOST_AFTER_DAYS,
  ghostCutoff,
  isApplicationStatus,
  shouldGhost,
  TERMINAL_STATUSES,
} from "@domain/pipeline/types.ts";
import { type ApiToken, type ApiTokenRepo, ApiTokenService, bearerFrom } from "@auth/api-token.ts";

const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------ the ghosting rule ------- */

Deno.test("ghosting: silence past the window makes an awaiting application stale", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const stale = { status: "sent" as const, lastActivityAt: new Date(now.getTime() - 22 * DAY) };
  assertEquals(shouldGhost(stale, now, 21), true);
});

Deno.test("ghosting: recent activity is not silence", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const fresh = { status: "sent" as const, lastActivityAt: new Date(now.getTime() - 3 * DAY) };
  assertEquals(shouldGhost(fresh, now, 21), false);
});

Deno.test("ghosting: the boundary is inclusive, so a run at exactly N days catches it", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const exact = { status: "sent" as const, lastActivityAt: ghostCutoff(now, 21) };
  assertEquals(shouldGhost(exact, now, 21), true);
});

Deno.test("ghosting: a closed application is never swept, however old", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const ancient = new Date(now.getTime() - 500 * DAY);
  for (const status of TERMINAL_STATUSES) {
    assertEquals(
      shouldGhost({ status, lastActivityAt: ancient }, now, 21),
      false,
      `${status} should not ghost`,
    );
  }
});

Deno.test("ghosting: drafting is not swept — nothing was sent, so silence means nothing", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const old = { status: "drafting" as const, lastActivityAt: new Date(now.getTime() - 90 * DAY) };
  assertEquals(shouldGhost(old, now, 21), false);
});

Deno.test("ghosting: an already-ghosted row is not re-swept", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const ghosted = {
    status: "ghosted" as const,
    lastActivityAt: new Date(now.getTime() - 90 * DAY),
  };
  assertEquals(shouldGhost(ghosted, now, 21), false);
});

Deno.test("ghosting: every awaiting status is swept and no status is in both sets", () => {
  // A status that is neither awaiting nor terminal is fine (drafting, ghosted),
  // but one in both would make the rule ambiguous.
  for (const status of AWAITING_STATUSES) {
    assert(!TERMINAL_STATUSES.has(status), `${status} cannot be both awaiting and terminal`);
  }
  for (const status of [...AWAITING_STATUSES, ...TERMINAL_STATUSES]) {
    assert(isApplicationStatus(status));
  }
});

Deno.test("the status vocabulary is closed", () => {
  assertEquals(isApplicationStatus("sent"), true);
  assertEquals(isApplicationStatus("ghosted"), true);
  assertEquals(isApplicationStatus("pending"), false);
  assertEquals(isApplicationStatus(""), false);
  assertEquals(APPLICATION_STATUSES.length, 9);
});

Deno.test("the default window is a sane number of days", () => {
  assert(DEFAULT_GHOST_AFTER_DAYS > 7 && DEFAULT_GHOST_AFTER_DAYS < 90);
});

/* ------------------------------------------------ bearer tokens ----------- */

/** The stored shape, minus `readonly` so the fake can mutate it in place. */
type Row = { -readonly [K in keyof ApiToken]: ApiToken[K] } & { hash: string };

class FakeTokenRepo implements ApiTokenRepo {
  readonly rows: Row[] = [];
  #next = 0;

  list(): Promise<ApiToken[]> {
    return Promise.resolve(this.rows.map(({ hash: _h, ...token }) => token));
  }

  create(input: { label: string; tokenHash: string; tokenPrefix: string }): Promise<ApiToken> {
    const token: Row = {
      id: `tok-${this.#next++}`,
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      createdAt: new Date(0),
      lastUsedAt: null,
      revokedAt: null,
      hash: input.tokenHash,
    };
    this.rows.push(token);
    const { hash: _h, ...rest } = token;
    return Promise.resolve(rest);
  }

  findActiveByHash(hash: string, usedAt: Date): Promise<ApiToken | null> {
    const row = this.rows.find((r) => r.hash === hash && r.revokedAt === null);
    if (row === undefined) return Promise.resolve(null);
    row.lastUsedAt = usedAt;
    const { hash: _h, ...rest } = row;
    return Promise.resolve(rest);
  }

  revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row !== undefined) row.revokedAt = at;
    return Promise.resolve();
  }
}

function tokenService() {
  const repo = new FakeTokenRepo();
  return { repo, service: new ApiTokenService(repo, new FixedClock("2026-08-03T00:00:00Z")) };
}

Deno.test("the plaintext token is never stored — only its hash", async () => {
  const { repo, service } = tokenService();
  const { plaintext } = await service.issue("n8n");

  const stored = JSON.stringify(repo.rows);
  assert(!stored.includes(plaintext), "the plaintext leaked into storage");
  // The displayed prefix is short enough to be useless as a credential.
  assert(plaintext.startsWith(repo.rows[0]!.tokenPrefix));
  assert(repo.rows[0]!.tokenPrefix.length < plaintext.length / 2);
});

Deno.test("a valid token verifies; a wrong one does not", async () => {
  const { service } = tokenService();
  const { plaintext, token } = await service.issue("n8n");

  const verified = await service.verify(plaintext);
  assertEquals(verified?.id, token.id);
  assertEquals(await service.verify(`${plaintext}x`), null);
  assertEquals(await service.verify(""), null);
  assertEquals(await service.verify("jrq_not-a-real-token"), null);
});

Deno.test("a revoked token stops verifying", async () => {
  const { service } = tokenService();
  const { plaintext, token } = await service.issue("n8n");
  assert(await service.verify(plaintext) !== null);

  await service.revoke(token.id);
  assertEquals(await service.verify(plaintext), null);
});

Deno.test("two tokens are distinct, and one does not verify as the other", async () => {
  const { service } = tokenService();
  const first = await service.issue("old");
  const second = await service.issue("new");
  assert(first.plaintext !== second.plaintext);
  assertEquals((await service.verify(first.plaintext))?.label, "old");
  assertEquals((await service.verify(second.plaintext))?.label, "new");
});

Deno.test("rotation leaves no window without a working credential", async () => {
  const { service } = tokenService();
  const old = await service.issue("n8n");
  // Mint the replacement first...
  const replacement = await service.issue("n8n (rotated)");
  assert(await service.verify(old.plaintext) !== null, "old must still work during handover");
  // ...then revoke the old one.
  await service.revoke(old.token.id);
  assertEquals(await service.verify(old.plaintext), null);
  assert(await service.verify(replacement.plaintext) !== null);
});

Deno.test("use is recorded, so a leaked token's use is visible", async () => {
  const { repo, service } = tokenService();
  const { plaintext } = await service.issue("n8n");
  assertEquals(repo.rows[0]!.lastUsedAt, null);
  await service.verify(plaintext);
  assertEquals(repo.rows[0]!.lastUsedAt, new Date("2026-08-03T00:00:00Z"));
});

Deno.test("bearerFrom parses the header and rejects everything else", () => {
  assertEquals(bearerFrom("Bearer abc123"), "abc123");
  assertEquals(bearerFrom("bearer abc123"), "abc123");
  assertEquals(bearerFrom("  Bearer   abc123  "), "abc123");
  assertEquals(bearerFrom("Basic abc123"), "");
  assertEquals(bearerFrom("abc123"), "");
  assertEquals(bearerFrom(undefined), "");
  assertEquals(bearerFrom(""), "");
});
