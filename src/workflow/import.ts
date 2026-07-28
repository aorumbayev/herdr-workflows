import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePayload, type WorkflowPayload } from "./bundle";
import { parseRaw } from "./parse";
import {
  analyzeRawWorkflow,
  formatSensitivityBanner,
  referencedWorkflowChildren,
  workflowDisplayTitle,
} from "./trust";
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
 * Schema-only check. Deliberately not the full load path: that resolves child workflows and
 * runs `options:` shell commands, which would execute the payload before the user consents.
 */
export function checkPayload(payload: string): WorkflowPayload {
  const workflow = decodePayload(payload);
  parseRaw(`${workflow.name}.yaml`, workflow.body);
  return workflow;
}

export function previewText(workflow: WorkflowPayload): string {
  const raw = parseRaw(`${workflow.name}.yaml`, workflow.body);
  const banner = formatSensitivityBanner(analyzeRawWorkflow(raw));
  const title = workflowDisplayTitle(workflow.name, raw.title);
  const desc = raw.description?.trim() ? `${raw.description.trim()}\n` : "";
  const children = referencedWorkflowChildren(raw);
  const childNote =
    children.length > 0
      ? `Note: this payload is a single workflow. Referenced children (${children.join(", ")}) are not included and will resolve from the importing repo (or be missing).\n`
      : "";
  return `--- ${workflow.name}.yaml (${title}) ---\n${banner}${childNote}${desc}${workflow.body}\n`;
}

export type ImportOutcome = { name: string; path: string; status: "written" | "exists" };

async function writeWorkflow(
  workflow: WorkflowPayload,
  dir: string,
  force: boolean,
): Promise<ImportOutcome> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${workflow.name}.yaml`);
  if (!force && (await Bun.file(path).exists())) {
    return { name: workflow.name, path, status: "exists" };
  }
  await Bun.write(path, workflow.body);
  return { name: workflow.name, path, status: "written" };
}

export const IMPORT_DISCLAIMER = `This payload came from outside your machine. Imported workflows are
reviewed executable code: they run shell commands and agent prompts with your
permissions. Read every line below before you accept it. There is no sandbox.`;

export type ImportPrompts = {
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
): Promise<{ workflow: WorkflowPayload; result: ImportOutcome; dir: string } | { aborted: true }> {
  const workflow = checkPayload(payload);
  if (opts.prompts && !(await opts.prompts.confirm(previewText(workflow)))) {
    return { aborted: true };
  }
  const scope = opts.scope ?? (await opts.prompts?.chooseScope());
  if (!scope) throw new WorkflowLoadError("no destination chosen (pass --to=repo|global)");
  const dir = scopeDir(scope, opts.repoRoot, opts.home ?? process.env.HOME ?? homedir());
  return {
    workflow,
    result: await writeWorkflow(workflow, dir, opts.force === true),
    dir,
  };
}
