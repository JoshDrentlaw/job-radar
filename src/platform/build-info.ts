/**
 * The commit the running process was deployed at.
 *
 * The app's --allow-read list is `./migrations` and `./static` only — it
 * cannot open `.git` and has no `--allow-run` to shell out to `git rev-parse`
 * (§11). So the deploy script writes the commit it just fast-forwarded to
 * into a plain file, before the restart that swaps this process in, and this
 * reads it once at startup. Nothing writes the file in development, and a
 * missing or unreadable file is not a startup failure — there is simply
 * nothing to show.
 */

export type FileReader = (path: string) => Promise<string>;

const readFile: FileReader = (path) => Deno.readTextFile(path);

/** The eight-character form the deploy script itself logs. */
export async function readDeployedCommit(
  path = "./COMMIT",
  read: FileReader = readFile,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    return undefined;
  }
  const sha = raw.trim();
  return sha === "" ? undefined : sha.slice(0, 8);
}

export const DEPLOYED_COMMIT = await readDeployedCommit();
