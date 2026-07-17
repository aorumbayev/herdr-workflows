import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from cwd looking for `.git` or `.hwf`. */
export async function resolveRepoRoot(start = process.cwd()): Promise<string> {
  let dir = start;
  for (;;) {
    if ((await present(join(dir, ".git"))) || (await present(join(dir, ".hwf")))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
