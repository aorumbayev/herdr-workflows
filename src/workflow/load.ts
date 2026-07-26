import { homedir } from "node:os";
import { join } from "node:path";
import { shellArgv, spawnCapture } from "../run/steps/shell";
import {
  AGENT_NAME_RE,
  checkAgents,
  flatNeedsInvokingAgent,
  flatNeedsPrompt,
  flatNeedsSession,
  isBuiltin,
  parseRaw,
  rawToFlat,
  stepOutNames,
  stepReferencedNames,
  textPlaceholders,
  type RawWorkflow,
} from "./parse";
import {
  bail,
  WorkflowLoadError,
  type FlatStep,
  type InputSpec,
  type LoadedWorkflow,
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

async function parseFile(file: string): Promise<{ file: string; raw: RawWorkflow }> {
  if (!(await Bun.file(file).exists())) {
    bail(file, undefined, undefined, "file not found");
  }
  return { file, raw: parseRaw(file, await Bun.file(file).text()) };
}

const AGENTS_BUILTIN = "agents";
const TEXT_DEFAULT_RE = /^text\s*=\s*(.*)$/s;
const SH_OPTIONS_RE = /^sh\s+(.+)$/s;

function unquoteDefault(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

type NormalizedInput = {
  label?: string;
  desc?: string;
  options?: string | string[];
  default?: string;
  text?: boolean;
};

function normalizeInput(
  file: string,
  name: string,
  raw: NonNullable<RawWorkflow["inputs"]>[string],
): NormalizedInput {
  if (typeof raw === "string") {
    if (raw === "text") return { text: true };
    if (raw === AGENTS_BUILTIN) return { options: AGENTS_BUILTIN };
    const textDef = TEXT_DEFAULT_RE.exec(raw);
    if (textDef) return { text: true, default: unquoteDefault(textDef[1]!) };
    const sh = SH_OPTIONS_RE.exec(raw);
    if (sh) return { options: sh[1]! };
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `unknown input shorthand '${raw}' (expected text, text = …, agents, sh <cmd>, or a list)`,
    );
  }
  if (Array.isArray(raw)) return { options: raw };
  const map = raw;
  if (map.type === "agents") {
    return { options: AGENTS_BUILTIN, label: map.label, desc: map.desc, default: map.default };
  }
  if (map.options !== undefined) {
    return {
      label: map.label,
      desc: map.desc,
      options: map.options,
      default: map.default,
    };
  }
  return {
    text: true,
    label: map.label,
    desc: map.desc,
    default: map.default,
  };
}

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

async function resolveInputs(
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

function checkInputRefs(
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

async function flattenUseStep(opts: {
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

async function flattenSteps(
  name: string,
  repoRoot: string,
  stack: string[],
  agents: Set<string>,
  parentBound: Set<string>,
  sources?: Set<"repo" | "global">,
  root?: { file: string; source: "repo" | "global" },
  rootRaw?: RawWorkflow,
): Promise<FlatStep[]> {
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
}

async function loadRecovery(
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
      bail(file, undefined, `inputs.${spec.name}`, "declared but never referenced");
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
