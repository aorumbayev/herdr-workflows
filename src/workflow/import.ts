import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRaw } from "./parse";
import { decodeBundle, type WorkflowBundle } from "./bundle";
import { WorkflowLoadError } from "./types";

export type ImportScope = "repo" | "global";

export function parseImportScope(raw: string): ImportScope | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "r" || v === "repo" || v === "local" || v === "cwd") return "repo";
  if (v === "g" || v === "global" || v === "home") return "global";
  return undefined;
}

function scopeDir(scope: ImportScope, repoRoot: string, home: string): string {
  return scope === "repo" ? join(repoRoot, ".hwf", "workflows") : join(home, ".hwf", "workflows");
}

/**
 * Schema-only check. Deliberately not the full load path: that resolves `use:` includes and
 * runs `options:` shell commands, which would execute the payload before the user consents.
 */
export function checkBundle(payload: string): WorkflowBundle {
  const bundle = decodeBundle(payload);
  for (const file of bundle.files) {
    parseRaw(`${file.name}.yaml`, file.body);
  }
  const names = bundle.files.map((f) => f.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new WorkflowLoadError(`payload lists '${dupe}' twice`);
  return bundle;
}

export function previewText(bundle: WorkflowBundle): string {
  const parts = bundle.files.map((f) => `--- ${f.name}.yaml ---\n${f.body.trimEnd()}`);
  return `${parts.join("\n\n")}\n`;
}

export type ImportOutcome = { name: string; path: string; status: "written" | "exists" };

async function writeBundle(
  bundle: WorkflowBundle,
  dir: string,
  force: boolean,
): Promise<ImportOutcome[]> {
  await mkdir(dir, { recursive: true });
  const results: ImportOutcome[] = [];
  for (const file of bundle.files) {
    const path = join(dir, `${file.name}.yaml`);
    if (!force && (await Bun.file(path).exists())) {
      results.push({ name: file.name, path, status: "exists" });
      continue;
    }
    await Bun.write(path, file.body.endsWith("\n") ? file.body : `${file.body}\n`);
    results.push({ name: file.name, path, status: "written" });
  }
  return results;
}

export const IMPORT_DISCLAIMER = `This payload came from outside your machine. Imported workflows run shell
commands and agent prompts with your permissions, on your repositories.
Read every line below before you accept it.`;

export type ImportPrompts = {
  /** Asks the reader to confirm they reviewed the preview. */
  confirm: (preview: string) => Promise<boolean>;
  chooseScope: () => Promise<ImportScope>;
};

export async function runImport(
  payload: string,
  opts: {
    repoRoot: string;
    home?: string;
    scope?: ImportScope;
    force?: boolean;
    prompts?: ImportPrompts;
  },
): Promise<{ bundle: WorkflowBundle; results: ImportOutcome[]; dir: string } | { aborted: true }> {
  const bundle = checkBundle(payload);
  if (opts.prompts && !(await opts.prompts.confirm(previewText(bundle)))) return { aborted: true };
  const scope = opts.scope ?? (await opts.prompts?.chooseScope());
  if (!scope) throw new WorkflowLoadError("no destination chosen (pass --to=repo|global)");
  const dir = scopeDir(scope, opts.repoRoot, opts.home ?? process.env.HOME ?? homedir());
  return { bundle, results: await writeBundle(bundle, dir, opts.force === true), dir };
}
