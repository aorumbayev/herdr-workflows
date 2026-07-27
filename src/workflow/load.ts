import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseRaw,
  workflowNeedsInvokingAgent,
  workflowNeedsTranscript,
  type RawWorkflow,
} from "./parse";
import {
  bail,
  WorkflowLoadError,
  type DynamicChoice,
  type InputSpec,
  type LoadedWorkflow,
  type RawInputValue,
  type WorkflowListEntry,
} from "./types";

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

export function workflowPath(scope: "repo" | "global", repoRoot: string, name: string): string {
  return join(scope === "repo" ? repoDir(repoRoot) : globalDir(), `${name}.yaml`);
}

async function resolveWorkflowFile(
  name: string,
  repoRoot: string,
): Promise<{ file: string; source: "repo" | "global" } | undefined> {
  const repo = workflowPath("repo", repoRoot, name);
  if (await Bun.file(repo).exists()) return { file: repo, source: "repo" };
  const global = workflowPath("global", repoRoot, name);
  if (await Bun.file(global).exists()) return { file: global, source: "global" };
  return undefined;
}

async function collectWorkflowEntries(repoRoot: string): Promise<WorkflowListEntry[]> {
  const map = new Map<string, WorkflowListEntry>();
  for (const name of await yamlNames(globalDir())) {
    map.set(name, { name, source: "global", file: workflowPath("global", repoRoot, name) });
  }
  for (const name of await yamlNames(repoDir(repoRoot))) {
    map.set(name, { name, source: "repo", file: workflowPath("repo", repoRoot, name) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function resolveInput(file: string, name: string, raw: RawInputValue): InputSpec {
  if (raw === "text") return { name, type: "text" };
  if (raw === "profile") return { name, type: "profile" };
  if (Array.isArray(raw)) return { name, type: "choice", options: raw };
  const type = raw.type ?? (raw.options !== undefined ? "choice" : "text");
  if (type === "choice") {
    if (!raw.options) {
      bail(file, undefined, `inputs.${name}`, "choice input requires options");
    }
    if (Array.isArray(raw.options)) {
      return {
        name,
        type: "choice",
        description: raw.description,
        default: raw.default,
        options: raw.options,
      };
    }
    return {
      name,
      type: "choice",
      description: raw.description,
      default: raw.default,
      dynamicOptions: raw.options as DynamicChoice,
    };
  }
  return {
    name,
    type,
    description: raw.description,
    default: raw.default,
  };
}

function inputsOf(file: string, raw: RawWorkflow): InputSpec[] {
  return Object.entries(raw.inputs ?? {}).map(([name, value]) => resolveInput(file, name, value));
}

function loadFromRaw(
  name: string,
  file: string,
  source: "repo" | "global",
  raw: RawWorkflow,
): LoadedWorkflow {
  const inputs = inputsOf(file, raw);
  return {
    name,
    file,
    version: raw.version,
    title: raw.title,
    description: raw.description,
    hidden: raw.hidden === true,
    steps: raw.steps,
    inputs,
    returns: raw.returns,
    onFailure: raw.onFailure,
    repoOwned: source === "repo",
    needsTranscript: workflowNeedsTranscript(raw.steps, raw.returns),
    needsInvokingAgent: workflowNeedsInvokingAgent(raw.steps),
  };
}

export async function parseWorkflowText(
  name: string,
  yaml: string,
  _agentNames: Iterable<string> = [],
  _repoRoot: string = process.cwd(),
  file = `${name}.yaml`,
): Promise<LoadedWorkflow> {
  return loadFromRaw(name, file, "repo", parseRaw(file, yaml));
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  _agentNames: Iterable<string> = [],
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadWorkflowEntry({ name, ...resolved }, repoRoot);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  _repoRoot: string,
  _agentNames: Iterable<string> = [],
  _resolveDynamic = true,
): Promise<LoadedWorkflow> {
  if (!(await Bun.file(entry.file).exists())) {
    bail(entry.file, undefined, undefined, "file not found");
  }
  const raw = parseRaw(entry.file, await Bun.file(entry.file).text());
  return loadFromRaw(entry.name, entry.file, entry.source, raw);
}

export async function listWorkflows(
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<WorkflowListEntry[]> {
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const workflow = await loadWorkflowEntry(entry, repoRoot, agentNames, false);
      entry.hidden = workflow.hidden;
      entry.needsTranscript = workflow.needsTranscript;
      entry.inputs = workflow.inputs;
      entry.repoOwned = workflow.repoOwned;
      entry.dynamicOptions = workflow.inputs.some((input) => input.dynamicOptions !== undefined);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
