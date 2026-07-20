import { resolveWorkflowFile } from "./discover";
import { WorkflowLoadError, positioned, type FlatStep } from "./errors";
import { flattenSteps, parseFile } from "./flatten";
import { checkAgents } from "./steps";

export async function assertNoOnFail(
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

export async function loadRecovery(
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
  if (parsed.raw.inputs !== undefined) {
    throw new WorkflowLoadError(
      positioned(
        entryFile,
        undefined,
        "on_fail",
        `recovery target '${onFail}' declares inputs — declare them on the entry workflow`,
      ),
    );
  }
  for (const step of parsed.raw.steps) {
    if (step.run !== undefined) await assertNoOnFail(step.run, repoRoot, resolved.file, 0);
  }
  const steps = await flattenSteps(onFail, repoRoot, []);
  checkAgents(entryFile, steps, agents);
  return steps;
}
