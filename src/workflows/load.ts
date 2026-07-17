import { collectWorkflowEntries, resolveWorkflowFile } from "./discover";
import {
  WorkflowLoadError,
  positioned,
  type FlatStep,
  type LoadedWorkflow,
  type WorkflowListEntry,
} from "./errors";
import { parseRaw, type RawWorkflow } from "./parse";
import {
  checkAgents,
  flatNeedsInvokingAgent,
  flatNeedsPrompt,
  flatNeedsSession,
  rawToFlat,
} from "./steps";

async function parseFile(file: string): Promise<{ file: string; raw: RawWorkflow }> {
  if (!(await Bun.file(file).exists())) {
    throw new WorkflowLoadError(positioned(file, undefined, undefined, "file not found"));
  }
  return { file, raw: parseRaw(file, await Bun.file(file).text()) };
}

async function flattenSteps(name: string, repoRoot: string, stack: string[]): Promise<FlatStep[]> {
  if (stack.includes(name)) {
    throw new WorkflowLoadError(
      positioned(
        `${name}.yaml`,
        undefined,
        "run",
        `cycle detected: ${[...stack, name].join(" → ")}`,
      ),
    );
  }
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) {
    const from = stack[stack.length - 1];
    throw new WorkflowLoadError(
      positioned(
        from ? `${from}.yaml` : `${name}.yaml`,
        undefined,
        "run",
        `unknown workflow '${name}'`,
      ),
    );
  }
  const parsed = await parseFile(resolved.file);
  const next = [...stack, name];
  const out: FlatStep[] = [];
  for (const [i, step] of parsed.raw.steps.entries()) {
    if (step.run !== undefined) out.push(...(await flattenSteps(step.run, repoRoot, next)));
    else out.push(rawToFlat(resolved.file, i + 1, step));
  }
  return out;
}

async function assertNoOnFail(
  name: string,
  repoRoot: string,
  fromFile: string,
  step: number,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(name)) return;
  seen.add(name);
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) {
    throw new WorkflowLoadError(positioned(fromFile, step, "run", `unknown workflow '${name}'`));
  }
  const parsed = await parseFile(resolved.file);
  if (parsed.raw.on_fail !== undefined) {
    throw new WorkflowLoadError(
      positioned(fromFile, step, "on_fail", `run target '${name}' declares on_fail`),
    );
  }
  for (const s of parsed.raw.steps) {
    if (s.run !== undefined) await assertNoOnFail(s.run, repoRoot, fromFile, step, seen);
  }
}

async function loadRecovery(
  entryFile: string,
  onFail: string,
  repoRoot: string,
  agents: Set<string>,
): Promise<FlatStep[]> {
  const resolved = await resolveWorkflowFile(onFail, repoRoot);
  if (!resolved) {
    throw new WorkflowLoadError(
      positioned(entryFile, undefined, "on_fail", `unknown workflow '${onFail}'`),
    );
  }
  const parsed = await parseFile(resolved.file);
  if (parsed.raw.on_fail !== undefined) {
    throw new WorkflowLoadError(
      positioned(entryFile, undefined, "on_fail", `recovery target '${onFail}' declares on_fail`),
    );
  }
  for (const step of parsed.raw.steps) {
    if (step.run !== undefined) await assertNoOnFail(step.run, repoRoot, resolved.file, 0);
  }
  const steps = await flattenSteps(onFail, repoRoot, []);
  checkAgents(entryFile, steps, agents);
  return steps;
}

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
  let needsPrompt = flatNeedsPrompt(steps);
  let needsSession = flatNeedsSession(steps);
  let needsInvokingAgent = flatNeedsInvokingAgent(steps);
  if (entry.raw.on_fail) {
    const recovery = await loadRecovery(resolved.file, entry.raw.on_fail, repoRoot, agents);
    needsPrompt = needsPrompt || flatNeedsPrompt(recovery);
    needsSession = needsSession || flatNeedsSession(recovery);
    needsInvokingAgent = needsInvokingAgent || flatNeedsInvokingAgent(recovery);
  }
  return {
    name,
    file: resolved.file,
    steps,
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
      entry.needsPrompt = (await loadWorkflow(entry.name, repoRoot, agentNames)).needsPrompt;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
