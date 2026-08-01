import { homedir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_NAME_RE, WorkflowLoadError } from "./types";

export const WORKFLOW_NAME_RULE = "workflow name must match [a-z0-9][a-z0-9-_]*";

function globalDir(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "workflows");
}

function repoDir(root: string): string {
  return join(root, ".hwf", "workflows");
}

export function assertWorkflowName(name: string): string {
  const n = name.trim();
  if (!WORKFLOW_NAME_RE.test(n)) {
    throw new WorkflowLoadError(WORKFLOW_NAME_RULE);
  }
  return n;
}

export function workflowPath(scope: "repo" | "global", repoRoot: string, name: string): string {
  const n = assertWorkflowName(name);
  return join(scope === "repo" ? repoDir(repoRoot) : globalDir(), `${n}.yaml`);
}

export async function resolveWorkflowFile(
  name: string,
  repoRoot: string,
): Promise<{ file: string; source: "repo" | "global" } | undefined> {
  const repo = workflowPath("repo", repoRoot, name);
  if (await Bun.file(repo).exists()) return { file: repo, source: "repo" };
  const global = workflowPath("global", repoRoot, name);
  if (await Bun.file(global).exists()) return { file: global, source: "global" };
  return undefined;
}
