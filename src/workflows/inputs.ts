import { shellArgv, spawnCapture } from "../runner/shell";
import { bail, type FlatStep, type InputSpec } from "./types";
import type { RawWorkflow } from "./parse";
import { isBuiltin } from "./substitute";
import { AGENT_NAME_RE, stepOutNames, stepReferencedNames } from "./steps";
import { AGENTS_BUILTIN, normalizeInput } from "./input-normalize";

export { AGENT_NAME_RE };

const OPTIONS_CMD_TIMEOUT_MS = 5_000;

/** True when `command` references `$HWF_<name>` or `$HWF_INPUT_<name>` exactly. */
function commandUsesEnv(command: string, name: string): boolean {
  for (const prefix of [`HWF_${name}`, `HWF_INPUT_${name}`]) {
    let from = 0;
    while (from <= command.length) {
      const i = command.indexOf(prefix, from);
      if (i === -1) break;
      const after = command[i + prefix.length];
      if (after === undefined || !/[A-Za-z0-9_]/.test(after)) return true;
      from = i + prefix.length;
    }
  }
  return false;
}

async function resolveOptionLines(
  file: string,
  inputName: string,
  command: string,
  repoRoot: string,
): Promise<string[]> {
  const result = await spawnCapture(shellArgv(command), {
    cwd: repoRoot,
    timeoutMs: OPTIONS_CMD_TIMEOUT_MS,
  });
  if (result.timedOut) {
    bail(
      file,
      undefined,
      `inputs.${inputName}`,
      `options command timed out after ${OPTIONS_CMD_TIMEOUT_MS / 1000}s`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    bail(file, undefined, `inputs.${inputName}`, `options command failed: ${detail}`);
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    bail(file, undefined, `inputs.${inputName}`, "options command produced no choices");
  }
  return lines;
}

export async function resolveInputs(
  file: string,
  raw: RawWorkflow,
  agents: Set<string>,
  repoRoot: string,
  resolveDynamic = true,
): Promise<InputSpec[]> {
  const specs: InputSpec[] = [];
  for (const [name, value] of Object.entries(raw.inputs ?? {})) {
    if (isBuiltin(name)) {
      bail(file, undefined, `inputs.${name}`, `name shadows builtin '{${name}}'`);
    }
    const input = normalizeInput(file, name, value);
    let options: string[] | undefined;
    let dynamicOptions = false;
    if (input.options !== undefined) {
      if (Array.isArray(input.options)) {
        options = input.options;
      } else if (input.options === AGENTS_BUILTIN) {
        if (agents.size === 0) {
          bail(file, undefined, `inputs.${name}`, "options: agents but no agents configured");
        }
        options = [...agents];
      } else if (resolveDynamic) {
        options = await resolveOptionLines(file, name, input.options, repoRoot);
      } else {
        dynamicOptions = true;
      }
    }
    if (options && input.default !== undefined && !options.includes(input.default)) {
      bail(file, undefined, `inputs.${name}`, `default '${input.default}' not in options`);
    }
    specs.push({
      name,
      label: input.label ?? name,
      desc: input.desc,
      options,
      ...(dynamicOptions ? { dynamicOptions: true } : {}),
      default: input.default,
    });
  }
  return specs;
}

function checkAgentInput(file: string, idx: number, spec: InputSpec, agents: Set<string>): void {
  if (spec.dynamicOptions) return;
  if (!spec.options) {
    bail(file, idx + 1, "agent", `input '${spec.name}' needs options: to be used as agent`);
  }
  for (const option of spec.options) {
    if (!agents.has(option)) {
      bail(file, idx + 1, "agent", `input '${spec.name}' option '${option}' is not a config agent`);
    }
  }
}

function checkIncludeNames(
  file: string,
  step: FlatStep,
  stepIndex: number,
  inputs: Map<string, InputSpec>,
  agents: Set<string>,
  knownNames: Set<string>,
  used: Set<string>,
  markInputUse: boolean,
): void {
  if (step.action.kind !== "include") return;
  const action = step.action;
  for (const name of stepReferencedNames(step)) {
    if (isBuiltin(name)) continue;
    if (!knownNames.has(name) && !inputs.has(name)) {
      bail(file, stepIndex, "with", `unknown name '{${name}}'`);
    }
    if (inputs.has(name) && markInputUse) used.add(name);
  }
  const childKnown = new Set<string>([
    ...Object.keys(action.with),
    ...Object.keys(action.defaults),
  ]);
  checkStepNames(file, new Map(), action.steps, agents, childKnown, used, false);
  for (const n of action.exportedOuts) knownNames.add(n);
}

function checkOneReferencedName(
  file: string,
  step: FlatStep,
  stepIndex: number,
  name: string,
  inputs: Map<string, InputSpec>,
  knownNames: Set<string>,
  used: Set<string>,
  markInputUse: boolean,
): void {
  if (name === "item" || name === "index") {
    if (!step.for) {
      bail(file, stepIndex, undefined, `{${name}} requires for:`);
    }
    return;
  }
  if (name === "attempt") {
    if (!step.retry) {
      bail(file, stepIndex, undefined, `{attempt} requires retry:`);
    }
    return;
  }
  if (isBuiltin(name)) return;
  if (knownNames.has(name)) {
    if (inputs.has(name) && markInputUse) used.add(name);
    return;
  }
  if (inputs.has(name)) {
    if (markInputUse) used.add(name);
    return;
  }
  bail(file, stepIndex, undefined, `unknown name '{${name}}'`);
}

function markRunEnvInputUses(
  step: FlatStep,
  inputs: Map<string, InputSpec>,
  used: Set<string>,
  markInputUse: boolean,
): void {
  if (step.action.kind !== "run" || step.action.payload.form === "argv") return;
  const command = step.action.payload.command;
  for (const name of inputs.keys()) {
    if (commandUsesEnv(command, name) && markInputUse) used.add(name);
  }
}

function checkAgentStepName(
  file: string,
  step: FlatStep,
  idx: number,
  stepIndex: number,
  inputs: Map<string, InputSpec>,
  agents: Set<string>,
  used: Set<string>,
  markInputUse: boolean,
): void {
  if (step.action.kind !== "agent") return;
  const m = AGENT_NAME_RE.exec(step.action.agent);
  if (!m || isBuiltin(m[1]!)) return;
  const spec = inputs.get(m[1]!);
  if (!spec) {
    bail(file, stepIndex, "agent", `unknown name '{${m[1]}}'`);
  }
  if (markInputUse) used.add(m[1]!);
  checkAgentInput(file, idx, spec, agents);
}

function checkAsAndOutNames(
  file: string,
  step: FlatStep,
  stepIndex: number,
  inputs: Map<string, InputSpec>,
  knownNames: Set<string>,
): void {
  if (step.as) {
    if (isBuiltin(step.as) || inputs.has(step.as) || knownNames.has(step.as)) {
      bail(file, stepIndex, "as", `name '${step.as}' collides with an existing name`);
    }
  }
  for (const name of stepOutNames(step)) {
    if (isBuiltin(name)) {
      bail(file, stepIndex, "out", `name shadows a builtin '{${name}}'`);
    }
    if (inputs.has(name) || knownNames.has(name)) {
      bail(file, stepIndex, "out", `name '${name}' collides with an existing name`);
    }
    knownNames.add(name);
  }
}

function checkStepNames(
  file: string,
  inputs: Map<string, InputSpec>,
  steps: FlatStep[],
  agents: Set<string>,
  knownNames: Set<string>,
  used: Set<string>,
  markInputUse: boolean,
): void {
  let idx = 0;
  for (const step of steps) {
    const stepIndex = idx + 1;
    if (step.action.kind === "include") {
      checkIncludeNames(file, step, stepIndex, inputs, agents, knownNames, used, markInputUse);
      idx++;
      continue;
    }

    for (const name of stepReferencedNames(step)) {
      checkOneReferencedName(file, step, stepIndex, name, inputs, knownNames, used, markInputUse);
    }

    markRunEnvInputUses(step, inputs, used, markInputUse);
    checkAgentStepName(file, step, idx, stepIndex, inputs, agents, used, markInputUse);
    checkAsAndOutNames(file, step, stepIndex, inputs, knownNames);
    idx++;
  }
}

export function checkInputRefs(
  file: string,
  inputs: Map<string, InputSpec>,
  steps: FlatStep[],
  agents: Set<string>,
  knownNames: Set<string>,
): Set<string> {
  const used = new Set<string>();
  checkStepNames(file, inputs, steps, agents, knownNames, used, true);
  return used;
}
