import { resolveWorkflowFile } from "./discover";
import { bail, type FlatStep } from "./types";
import { rawToFlat, stepOutNames } from "./steps";
import { flattenUseStep } from "./flatten-include";
import { parseFile } from "./flatten-parse";
import type { FlattenFn } from "./flatten-types";

export { parseFile };

export const flattenSteps: FlattenFn = async (
  name,
  repoRoot,
  stack,
  agents,
  parentBound,
  sources,
  root,
  rootRaw,
) => {
  if (stack.includes(name)) {
    bail(`${name}.yaml`, undefined, "use", `cycle detected: ${[...stack, name].join(" → ")}`);
  }
  const resolved = stack.length === 0 && root ? root : await resolveWorkflowFile(name, repoRoot);
  if (!resolved) {
    const from = stack[stack.length - 1];
    bail(from ? `${from}.yaml` : `${name}.yaml`, undefined, "use", `unknown workflow '${name}'`);
  }
  sources?.add(resolved.source);
  const parsed =
    stack.length === 0 && rootRaw
      ? { file: resolved.file, raw: rootRaw }
      : await parseFile(resolved.file);

  const out: FlatStep[] = [];
  const localBound = new Set(parentBound);

  for (const [i, step] of parsed.raw.steps.entries()) {
    if (step.use !== undefined) {
      out.push(
        await flattenUseStep({
          file: resolved.file,
          stepIndex: i + 1,
          step,
          parentName: name,
          stack,
          repoRoot,
          agents,
          localBound,
          parentBound,
          sources,
          flattenSteps,
        }),
      );
      continue;
    }

    const flat = rawToFlat(resolved.file, i + 1, step);
    if (step.on_error !== undefined) {
      flat.onError = await resolveStepOnError(
        resolved.file,
        i + 1,
        step.on_error,
        repoRoot,
        agents,
        sources,
        localBound,
      );
    }
    for (const n of stepOutNames(flat)) localBound.add(n);
    out.push(flat);
  }
  return out;
};

export async function loadRecovery(
  entryFile: string,
  onError: string,
  repoRoot: string,
  agents: Set<string>,
  sources?: Set<"repo" | "global">,
  bound: Set<string> = new Set(),
): Promise<FlatStep[]> {
  const resolved = await resolveWorkflowFile(onError, repoRoot);
  if (!resolved) {
    bail(entryFile, undefined, "on_error", `unknown workflow '${onError}'`);
  }
  const parsed = await parseFile(resolved.file);
  sources?.add(resolved.source);
  if (parsed.raw.on_error !== undefined) {
    bail(entryFile, undefined, "on_error", `recovery target '${onError}' declares on_error`);
  }
  if (parsed.raw.inputs !== undefined) {
    bail(entryFile, undefined, "on_error", `recovery workflows cannot declare inputs`);
  }
  return flattenSteps(onError, repoRoot, [], agents, bound, sources, resolved, parsed.raw);
}

async function resolveStepOnError(
  file: string,
  stepIndex: number,
  value: unknown,
  repoRoot: string,
  agents: Set<string>,
  sources: Set<"repo" | "global"> | undefined,
  bound: Set<string>,
): Promise<{ name: string; steps: FlatStep[] }> {
  if (typeof value === "string") {
    const steps = await loadRecovery(file, value, repoRoot, agents, sources, bound);
    return { name: value, steps };
  }
  if (Array.isArray(value)) {
    return {
      name: `<on_error@${stepIndex}>`,
      steps: value.map((raw) => rawToFlat(file, stepIndex, raw as never)),
    };
  }
  bail(file, stepIndex, "on_error", "on_error: must be a workflow name or step list");
}
