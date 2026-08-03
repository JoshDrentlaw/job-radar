/**
 * Branded identifier types and their composition rules.
 *
 * Ids are structured, not opaque: a BoardId is `${platform}:${slug}` and a
 * PostingId is `${boardId}:${externalId}` (§5). Building them in one place
 * keeps the format from drifting between the adapters and the repositories.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type BoardId = Brand<string, "BoardId">;
export type PostingId = Brand<string, "PostingId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;

export const PLATFORMS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "recruitee",
  "workable",
  "personio",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export class IdError extends Error {
  override readonly name = "IdError";
}

/**
 * Slugs travel into URLs, so they are restricted rather than merely trimmed.
 * The colon is excluded because it is the id delimiter.
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function assertValidSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new IdError(
      `Invalid board slug: ${JSON.stringify(slug)}. ` +
        "Expected 1-100 characters of letters, digits, dot, underscore or hyphen.",
    );
  }
  return slug;
}

export function boardId(platform: Platform, slug: string): BoardId {
  return `${platform}:${assertValidSlug(slug)}` as BoardId;
}

export function parseBoardId(value: string): { platform: Platform; slug: string } {
  const separator = value.indexOf(":");
  if (separator === -1) throw new IdError(`Malformed BoardId: ${JSON.stringify(value)}`);
  const platform = value.slice(0, separator);
  const slug = value.slice(separator + 1);
  if (!isPlatform(platform)) {
    throw new IdError(`Unknown platform in BoardId: ${JSON.stringify(platform)}`);
  }
  assertValidSlug(slug);
  return { platform, slug };
}

export function asBoardId(value: string): BoardId {
  parseBoardId(value);
  return value as BoardId;
}

/**
 * External ids are whatever the upstream ATS says they are, so they are not
 * pattern-checked — only required to be non-empty and free of the delimiter
 * collision that would make a PostingId ambiguous to read back.
 */
export function postingId(board: BoardId, externalId: string): PostingId {
  const trimmed = externalId.trim();
  if (trimmed === "") throw new IdError("External posting id must not be empty");
  return `${board}:${trimmed}` as PostingId;
}

export function parsePostingId(value: string): { boardId: BoardId; externalId: string } {
  const parts = value.split(":");
  if (parts.length < 3) throw new IdError(`Malformed PostingId: ${JSON.stringify(value)}`);
  const [platform, slug, ...rest] = parts;
  const board = boardId(platform as Platform, slug ?? "");
  if (!isPlatform(platform ?? "")) {
    throw new IdError(`Unknown platform in PostingId: ${JSON.stringify(platform)}`);
  }
  return { boardId: board, externalId: rest.join(":") };
}

export function asPostingId(value: string): PostingId {
  parsePostingId(value);
  return value as PostingId;
}

export function newSnapshotId(): SnapshotId {
  return crypto.randomUUID() as SnapshotId;
}
