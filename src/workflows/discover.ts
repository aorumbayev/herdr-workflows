import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkflowListEntry } from "./errors";

function globalDir(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "workflows");
}
function repoDir(root: string): string {
  return join(root, ".hwf", "workflows");
}

async function yamlNames(dir: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const path of new Bun.Glob("*.yaml").scan({ cwd: dir })) {
      names.push(path.replace(/\.yaml$/, ""));
    }
    return names.sort();
  } catch {
    return [];
  }
}

export async function resolveWorkflowFile(
  name: string,
  repoRoot: string,
): Promise<{ file: string; source: "repo" | "global" } | undefined> {
  const repo = join(repoDir(repoRoot), `${name}.yaml`);
  if (await Bun.file(repo).exists()) return { file: repo, source: "repo" };
  const global = join(globalDir(), `${name}.yaml`);
  if (await Bun.file(global).exists()) return { file: global, source: "global" };
  return undefined;
}

export async function collectWorkflowEntries(repoRoot: string): Promise<WorkflowListEntry[]> {
  const map = new Map<string, WorkflowListEntry>();
  for (const name of await yamlNames(globalDir())) {
    map.set(name, { name, source: "global", file: join(globalDir(), `${name}.yaml`) });
  }
  for (const name of await yamlNames(repoDir(repoRoot))) {
    map.set(name, { name, source: "repo", file: join(repoDir(repoRoot), `${name}.yaml`) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
