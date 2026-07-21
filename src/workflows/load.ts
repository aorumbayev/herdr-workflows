import { collectWorkflowEntries, resolveWorkflowFile } from "./discover";
import {
  WorkflowLoadError,
  positioned,
  type FlatStep,
  type LoadedWorkflow,
  type WorkflowListEntry,
} from "./errors";

import { checkInputRefs, resolveInputs } from "./inputs";
import { flattenSteps, parseFile } from "./flatten";
import { assertNoOnFail, loadRecovery } from "./recovery";
import { checkAgents, flatNeedsInvokingAgent, flatNeedsPrompt, flatNeedsSession } from "./steps";

async function loadResolvedWorkflow(
  name: string,
  repoRoot: string,
  agentNames: Iterable<string>,
  resolved: { file: string; source: "repo" | "global" },
  resolveDynamic: boolean,
): Promise<LoadedWorkflow> {
  const agents = new Set(agentNames);
  const entry = await parseFile(resolved.file);
  const sources = new Set<"repo" | "global">([resolved.source]);
  for (const [i, step] of entry.raw.steps.entries()) {
    if (step.run !== undefined) await assertNoOnFail(step.run, repoRoot, resolved.file, i + 1);
  }

  const steps = await flattenSteps(name, repoRoot, [], sources, resolved);
  checkAgents(resolved.file, steps, agents);
  const inputs = await resolveInputs(resolved.file, entry.raw, agents, repoRoot, resolveDynamic);
  const declared = new Map(inputs.map((spec) => [spec.name, spec]));
  const used = checkInputRefs(resolved.file, declared, steps, agents);
  let needsPrompt = flatNeedsPrompt(steps);
  let needsSession = flatNeedsSession(steps);
  let needsInvokingAgent = flatNeedsInvokingAgent(steps);
  let recovery: FlatStep[] | undefined;
  if (entry.raw.on_fail) {
    recovery = await loadRecovery(resolved.file, entry.raw.on_fail, repoRoot, agents, sources);
    for (const name of checkInputRefs(resolved.file, declared, recovery, agents)) used.add(name);
    needsPrompt = needsPrompt || flatNeedsPrompt(recovery);
    needsSession = needsSession || flatNeedsSession(recovery);
    needsInvokingAgent = needsInvokingAgent || flatNeedsInvokingAgent(recovery);
  }
  for (const spec of inputs) {
    if (!used.has(spec.name)) {
      throw new WorkflowLoadError(
        positioned(
          resolved.file,
          undefined,
          `inputs.${spec.name}`,
          "declared but never referenced",
        ),
      );
    }
  }
  return {
    name,
    file: resolved.file,
    steps,
    inputs,
    onFail: entry.raw.on_fail,
    ...(recovery ? { recovery: { name: entry.raw.on_fail!, steps: recovery } } : {}),
    repoOwned: sources.has("repo"),
    needsPrompt,
    needsSession,
    needsInvokingAgent,
  };
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadResolvedWorkflow(name, repoRoot, agentNames, resolved, true);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  repoRoot: string,
  agentNames: Iterable<string> = [],
  resolveDynamic = true,
): Promise<LoadedWorkflow> {
  return loadResolvedWorkflow(entry.name, repoRoot, agentNames, entry, resolveDynamic);
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
