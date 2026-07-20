import { collectWorkflowEntries, resolveWorkflowFile } from "./discover";
import {
  WorkflowLoadError,
  positioned,
  type FlatStep,
  type InputSpec,
  type LoadedWorkflow,
  type WorkflowListEntry,
} from "./errors";

import { checkInputRefs, resolveInputs } from "./inputs";
import { flattenSteps, parseFile } from "./flatten";
import { assertNoOnFail, loadRecovery } from "./recovery";
import { checkAgents, flatNeedsInvokingAgent, flatNeedsPrompt, flatNeedsSession } from "./steps";

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<LoadedWorkflow> {
  const agents = new Set(agentNames);
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);

  const entry = await parseFile(resolved.file);
  for (const [i, step] of entry.raw.steps.entries()) {
    if (step.run !== undefined) await assertNoOnFail(step.run, repoRoot, resolved.file, i + 1);
  }

  const steps = await flattenSteps(name, repoRoot, []);
  checkAgents(resolved.file, steps, agents);
  const inputs = resolveInputs(resolved.file, entry.raw, agents);
  const declared = new Map(inputs.map((spec) => [spec.name, spec]));
  const used = checkInputRefs(resolved.file, declared, steps, agents);
  let needsPrompt = flatNeedsPrompt(steps);
  let needsSession = flatNeedsSession(steps);
  let needsInvokingAgent = flatNeedsInvokingAgent(steps);
  if (entry.raw.on_fail) {
    const recovery = await loadRecovery(resolved.file, entry.raw.on_fail, repoRoot, agents);
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
    needsPrompt,
    needsSession,
    needsInvokingAgent,
  };
}

export async function listWorkflows(
  repoRoot: string,
  agentNames: Iterable<string> = [],
): Promise<WorkflowListEntry[]> {
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const wf = await loadWorkflow(entry.name, repoRoot, agentNames);
      entry.needsPrompt = wf.needsPrompt;
      entry.inputs = wf.inputs;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
