import { collectWorkflowEntries, resolveWorkflowFile } from "./discover";
import {
  WorkflowLoadError,
  positioned,
  type FlatStep,
  type LoadedWorkflow,
  type WorkflowListEntry,
} from "./types";

import { checkInputRefs, resolveInputs } from "./inputs";
import { flattenSteps, loadRecovery, parseFile } from "./flatten";
import { parseRaw, type RawWorkflow } from "./parse";
import {
  checkAgents,
  flatNeedsInvokingAgent,
  flatNeedsPrompt,
  flatNeedsSession,
  rawToFlat,
} from "./steps";

async function loadFromRaw(
  name: string,
  file: string,
  source: "repo" | "global",
  raw: RawWorkflow,
  repoRoot: string,
  agentNames: Iterable<string>,
  resolveDynamic: boolean,
): Promise<LoadedWorkflow> {
  const agents = new Set(agentNames);
  const sources = new Set<"repo" | "global">([source]);
  const inputs = await resolveInputs(file, raw, agents, repoRoot, resolveDynamic);
  const declared = new Map(inputs.map((spec) => [spec.name, spec]));
  const bound = new Set(declared.keys());
  const steps = await flattenSteps(
    name,
    repoRoot,
    [],
    agents,
    bound,
    sources,
    { file, source },
    raw,
  );
  checkAgents(file, steps, agents);
  const used = checkInputRefs(file, declared, steps, agents, new Set(bound));
  let recovery: FlatStep[] | undefined;
  let onErrorName: string | undefined;
  if (typeof raw.on_error === "string") {
    onErrorName = raw.on_error;
    recovery = await loadRecovery(file, raw.on_error, repoRoot, agents, sources, bound);
    for (const name of checkInputRefs(file, declared, recovery, agents, new Set(bound))) {
      used.add(name);
    }
  } else if (Array.isArray(raw.on_error)) {
    onErrorName = "<on_error>";
    recovery = raw.on_error.map((step, i) => rawToFlat(file, i + 1, step));
    for (const name of checkInputRefs(file, declared, recovery, agents, new Set(bound))) {
      used.add(name);
    }
  }
  const allSteps = recovery ? [...steps, ...recovery] : steps;
  for (const spec of inputs) {
    if (!used.has(spec.name)) {
      throw new WorkflowLoadError(
        positioned(file, undefined, `inputs.${spec.name}`, "declared but never referenced"),
      );
    }
  }
  return {
    name,
    file,
    desc: raw.desc,
    steps,
    inputs,
    onError: onErrorName,
    ...(recovery ? { recovery: { name: onErrorName!, steps: recovery } } : {}),
    repoOwned: sources.has("repo"),
    needsPrompt: flatNeedsPrompt(allSteps),
    needsSession: flatNeedsSession(allSteps),
    needsInvokingAgent: flatNeedsInvokingAgent(allSteps),
  };
}

/**
 * Validate an in-memory YAML buffer through the exact file-load path so buffer and file
 * validation produce identical positioned errors. `file` is the label used in those errors
 * (defaults to `<name>.yaml`); splices and dynamic options still resolve against `repoRoot`.
 */
export async function parseWorkflowText(
  name: string,
  yaml: string,
  agentNames: Iterable<string> = [],
  repoRoot: string = process.cwd(),
  file = `${name}.yaml`,
): Promise<LoadedWorkflow> {
  const raw = parseRaw(file, yaml);
  return loadFromRaw(name, file, "repo", raw, repoRoot, agentNames, true);
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadWorkflowEntry({ name, ...resolved }, repoRoot, agentNames);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  repoRoot: string,
  agentNames: Iterable<string> = [],
  resolveDynamic = true,
): Promise<LoadedWorkflow> {
  const raw = await parseFile(entry.file);
  return loadFromRaw(
    entry.name,
    entry.file,
    entry.source,
    raw.raw,
    repoRoot,
    agentNames,
    resolveDynamic,
  );
}

export async function listWorkflows(
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<WorkflowListEntry[]> {
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const workflow = await loadWorkflowEntry(entry, repoRoot, agentNames, false);
      entry.needsPrompt = workflow.needsPrompt;
      entry.inputs = workflow.inputs;
      entry.repoOwned = workflow.repoOwned;
      entry.dynamicOptions = workflow.inputs.some((input) => input.dynamicOptions);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
