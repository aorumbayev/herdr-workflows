import { resolveWorkflowFile } from "./discover";
import { bail, type FlatStep, type InputSpec } from "./types";
import { parseFile } from "./flatten-parse";
import type { FlattenFn } from "./flatten-types";
import { resolveInputs } from "./inputs";
import { isBuiltin, textPlaceholders } from "./substitute";
import { stepOutNames } from "./steps";

function defaultsFromInputs(inputs: InputSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of inputs) {
    if (spec.default !== undefined) out[spec.name] = spec.default;
  }
  return out;
}

function parseWithMap(
  file: string,
  stepIndex: number,
  step: Record<string, unknown>,
  localBound: Set<string>,
): Record<string, string> {
  const withMap =
    step.with && typeof step.with === "object" && !Array.isArray(step.with)
      ? (step.with as Record<string, string>)
      : {};
  for (const [k, v] of Object.entries(withMap)) {
    if (typeof v !== "string") {
      bail(file, stepIndex, "with", `with.${k} must be a string`);
    }
    for (const ph of textPlaceholders(v)) {
      if (!isBuiltin(ph) && !localBound.has(ph)) {
        bail(file, stepIndex, "with", `unknown name '{${ph}}'`);
      }
    }
  }
  return withMap;
}

async function resolveIncludeTarget(opts: {
  file: string;
  stepIndex: number;
  useName: string;
  withMap: Record<string, string>;
  repoRoot: string;
  agents: Set<string>;
  sources?: Set<"repo" | "global">;
}): Promise<{
  defaults: Record<string, string>;
  target: NonNullable<Awaited<ReturnType<typeof resolveWorkflowFile>>>;
  targetParsed: Awaited<ReturnType<typeof parseFile>>;
}> {
  const { file, stepIndex, useName, withMap, repoRoot, agents, sources } = opts;
  const target = await resolveWorkflowFile(useName, repoRoot);
  if (!target) {
    bail(file, stepIndex, "use", `unknown workflow '${useName}'`);
  }
  const targetParsed = await parseFile(target.file);
  sources?.add(target.source);
  const targetInputs = await resolveInputs(target.file, targetParsed.raw, agents, repoRoot, true);
  const declared = new Set(targetInputs.map((s) => s.name));
  for (const key of Object.keys(withMap)) {
    if (!declared.has(key)) {
      bail(file, stepIndex, "with", `undeclared parameter '${key}'`);
    }
  }
  const defaults = defaultsFromInputs(targetInputs);
  for (const spec of targetInputs) {
    if (withMap[spec.name] === undefined && spec.default === undefined) {
      bail(file, stepIndex, "with", `required input '${spec.name}' of '${useName}' not supplied`);
    }
  }
  return { defaults, target, targetParsed };
}

function collectExportedOuts(
  file: string,
  stepIndex: number,
  useName: string,
  parentName: string,
  childSteps: FlatStep[],
  localBound: Set<string>,
  parentBound: Set<string>,
): string[] {
  const exportedOuts: string[] = [];
  for (const child of childSteps) {
    for (const n of stepOutNames(child)) {
      if (localBound.has(n) || parentBound.has(n)) {
        bail(
          file,
          stepIndex,
          "use",
          `out name '${n}' from '${useName}' collides with a name in '${parentName}'`,
        );
      }
      exportedOuts.push(n);
      localBound.add(n);
    }
  }
  return exportedOuts;
}

export async function flattenUseStep(opts: {
  file: string;
  stepIndex: number;
  step: Record<string, unknown>;
  parentName: string;
  stack: string[];
  repoRoot: string;
  agents: Set<string>;
  localBound: Set<string>;
  parentBound: Set<string>;
  sources?: Set<"repo" | "global">;
  flattenSteps: FlattenFn;
}): Promise<FlatStep> {
  const {
    file,
    stepIndex,
    step,
    parentName,
    stack,
    repoRoot,
    agents,
    localBound,
    parentBound,
    sources,
    flattenSteps,
  } = opts;
  if (typeof step.use !== "string" || !step.use) {
    bail(file, stepIndex, "use", "use: requires a workflow name");
  }
  const withMap = parseWithMap(file, stepIndex, step, localBound);
  const { defaults, target, targetParsed } = await resolveIncludeTarget({
    file,
    stepIndex,
    useName: step.use,
    withMap,
    repoRoot,
    agents,
    sources,
  });

  const childBound = new Set<string>([...Object.keys(withMap), ...Object.keys(defaults)]);
  const childSteps = await flattenSteps(
    step.use,
    repoRoot,
    [...stack, parentName],
    agents,
    childBound,
    sources,
    target,
    targetParsed.raw,
  );
  const exportedOuts = collectExportedOuts(
    file,
    stepIndex,
    step.use,
    parentName,
    childSteps,
    localBound,
    parentBound,
  );
  return {
    name: typeof step.name === "string" ? step.name : undefined,
    action: {
      kind: "include",
      workflow: step.use,
      with: withMap,
      defaults,
      steps: childSteps,
      exportedOuts,
    },
    when: undefined,
    wait: { kind: "block" },
    allowFail: step.allow_fail === true ? true : undefined,
  };
}
