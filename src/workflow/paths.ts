import { homedir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_NAME_RE, WorkflowLoadError } from "./types";

function globalDir(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "workflows");
}

function repoDir(root: string): string {
  return join(root, ".hwf", "workflows");
}

export function workflowPath(scope: "repo" | "global", repoRoot: string, name: string): string {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new WorkflowLoadError("workflow name must match [a-z0-9][a-z0-9-_]*");
  }
  return join(scope === "repo" ? repoDir(repoRoot) : globalDir(), `${name}.yaml`);
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
