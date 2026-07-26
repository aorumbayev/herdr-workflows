import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from cwd looking for `.git` or `.hwf`. */
export async function resolveRepoRoot(start = process.cwd()): Promise<string> {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".hwf"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
