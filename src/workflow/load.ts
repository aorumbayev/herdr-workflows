import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, profileNames, type WorkflowsConfig } from "../config";
import { CaptureLimitError } from "../limits";
import { spawnCapture } from "../run/steps/shell";
import {
  parseRaw,
  parseWhenClause,
  workflowNeedsTranscript,
  workflowTemplateRefs,
  type RawWorkflow,
} from "./parse";
import {
  bail,
  WorkflowLoadError,
  type DynamicChoice,
  type InputSpec,
  type LoadedWorkflow,
  type RawInputValue,
  type RecoveryAction,
  type ReturnsSpec,
  type WorkflowListEntry,
  type WorkflowStep,
} from "./types";
import { analyzeResolvedSensitivity } from "./trust";
import {
  assertChildInputContract,
  assertWorkflowReferences,
  shellUsesInput,
  workflowChildNames,
} from "./validate";

const DYNAMIC_CHOICE_TIMEOUT_MS = 10_000;
const DYNAMIC_CHOICE_MAX = 1_000;
const STDERR_TAIL = 500;
const EMPTY_CONFIG: WorkflowsConfig = { profiles: {}, transcripts: {} };
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

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
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new WorkflowLoadError("workflow name must match [a-z0-9][a-z0-9-_]*");
  }
  return join(scope === "repo" ? repoDir(repoRoot) : globalDir(), `${name}.yaml`);
}

export async function resolveWorkflowFile(
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

function inputIsUsed(
  name: string,
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
  inputs: InputSpec[] = [],
): boolean {
  const refs = workflowTemplateRefs(steps, returns, onFailure);
  if (refs.some((p) => p.root === "inputs" && p.segments[0] === name)) return true;
  for (const input of inputs) {
    for (const clause of input.when ?? []) {
      const parts = clause.path.split(".");
      if (parts[0] === "inputs" && parts[1] === name) return true;
    }
  }
  for (const step of steps) {
    if (step.action.kind === "run" && step.action.payload.form === "shell") {
      if (shellUsesInput(step.action.payload.command, name)) return true;
    }
  }
  if (onFailure?.kind === "run" && onFailure.payload.form === "shell") {
    if (shellUsesInput(onFailure.payload.command, name)) return true;
  }
  return false;
}

export function parseDynamicChoiceStdout(stdout: string): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push(value);
  }
  return choices;
}

export async function resolveDynamicChoices(
  file: string,
  name: string,
  dynamic: DynamicChoice,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  for (const el of dynamic.run) {
    if (el.includes("{{")) {
      bail(file, undefined, `inputs.${name}.options.run`, "dynamic choice argv rejects templates");
    }
  }
  let result: Awaited<ReturnType<typeof spawnCapture>>;
  try {
    result = await spawnCapture(dynamic.run, {
      cwd: repoRoot,
      env,
      timeoutMs: DYNAMIC_CHOICE_TIMEOUT_MS,
      maxCaptureBytes: { source: `inputs.${name} dynamic choice` },
    });
  } catch (error) {
    if (error instanceof CaptureLimitError) {
      bail(file, undefined, `inputs.${name}`, error.message);
    }
    throw error;
  }
  if (result.timedOut) {
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `dynamic choice failed: timed out after ${result.timeoutMs / 1000}s`,
    );
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-STDERR_TAIL) || `exit ${result.exitCode}`;
    bail(file, undefined, `inputs.${name}`, `dynamic choice failed: ${tail}`);
  }
  const choices = parseDynamicChoiceStdout(result.stdout);
  if (choices.length === 0) {
    bail(file, undefined, `inputs.${name}`, "dynamic choice produced no options");
  }
  if (choices.length > DYNAMIC_CHOICE_MAX) {
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `dynamic choice produced ${choices.length} options (limit ${DYNAMIC_CHOICE_MAX})`,
    );
  }
  return choices;
}

function resolveInput(file: string, name: string, raw: RawInputValue): InputSpec {
  if (raw === "text") return { name, type: "text" };
  if (raw === "profile") return { name, type: "profile" };
  if (Array.isArray(raw)) return { name, type: "choice", options: raw };
  const type = raw.type ?? (raw.options !== undefined ? "choice" : "text");
  const whenClauses =
    raw.when === undefined
      ? undefined
      : (Array.isArray(raw.when) ? raw.when : [raw.when]).map((clause, i) =>
          parseWhenClause(
            file,
            undefined,
            Array.isArray(raw.when) ? `inputs.${name}.when[${i}]` : `inputs.${name}.when`,
            clause,
          ),
        );
  const extras = {
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.default !== undefined ? { default: raw.default } : {}),
    ...(whenClauses !== undefined ? { when: whenClauses } : {}),
    ...(raw.allow_custom === true ? { allowCustom: true } : {}),
    ...(raw.min_length !== undefined ? { minLength: raw.min_length } : {}),
  };
  if (type === "choice") {
    if (!raw.options) {
      bail(file, undefined, `inputs.${name}`, "choice input requires options");
    }
    if (Array.isArray(raw.options)) {
      return { name, type: "choice", options: raw.options, ...extras };
    }
    return {
      name,
      type: "choice",
      dynamicOptions: raw.options as DynamicChoice,
      ...extras,
    };
  }
  return { name, type, ...extras };
}

function inputsOf(file: string, raw: RawWorkflow): InputSpec[] {
  return Object.entries(raw.inputs ?? {}).map(([name, value]) => resolveInput(file, name, value));
}

function assertInputsUsed(file: string, workflow: LoadedWorkflow): void {
  for (const input of workflow.inputs) {
    if (
      !inputIsUsed(
        input.name,
        workflow.steps,
        workflow.returns,
        workflow.onFailure,
        workflow.inputs,
      )
    ) {
      bail(file, undefined, `inputs.${input.name}`, "unused input");
    }
  }
}

function assertDefaultInOptions(file: string, input: InputSpec): void {
  if (input.default === undefined || input.options === undefined) return;
  if (input.allowCustom) return;
  if (!input.options.includes(input.default)) {
    bail(
      file,
      undefined,
      `inputs.${input.name}.default`,
      `default '${input.default}' is not in available values`,
    );
  }
}

function finalizeInputs(file: string, inputs: InputSpec[]): InputSpec[] {
  for (const input of inputs) {
    if (input.type === "choice") {
      if (input.options !== undefined && input.options.length === 0) {
        bail(file, undefined, `inputs.${input.name}`, "choice produced no options");
      }
      assertDefaultInOptions(file, input);
    }
  }
  return inputs;
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
  };
}

type LoadScope = {
  repoRoot: string;
  config: WorkflowsConfig;
  stack: string[];
  cache: Map<string, LoadedWorkflow>;
};

async function loadChild(name: string, scope: LoadScope): Promise<LoadedWorkflow> {
  if (scope.stack.includes(name)) {
    throw new WorkflowLoadError(`workflow cycle: ${[...scope.stack, name].join(" → ")}`);
  }
  const cached = scope.cache.get(name);
  if (cached) return cached;
  const resolved = await resolveWorkflowFile(name, scope.repoRoot);
  if (!resolved) {
    throw new WorkflowLoadError(
      `workflow '${name}' not found (via ${scope.stack.join(" → ") || "entry"})`,
    );
  }
  const raw = parseRaw(resolved.file, await Bun.file(resolved.file).text());
  const workflow = loadFromRaw(name, resolved.file, resolved.source, raw);
  const loaded = await finalizeWorkflow(workflow, {
    ...scope,
    stack: [...scope.stack, name],
  });
  scope.cache.set(name, loaded);
  return loaded;
}

async function finalizeWorkflow(
  workflow: LoadedWorkflow,
  scope: LoadScope,
): Promise<LoadedWorkflow> {
  assertInputsUsed(workflow.file, workflow);
  const inputs = finalizeInputs(workflow.file, workflow.inputs);
  const withInputs = { ...workflow, inputs };

  const childReturnsById = new Map<string, ReturnsSpec | undefined>();
  const children = new Map<string, LoadedWorkflow>();
  for (const childName of workflowChildNames(withInputs)) {
    if (!children.has(childName)) {
      children.set(childName, await loadChild(childName, scope));
    }
  }
  for (let i = 0; i < withInputs.steps.length; i++) {
    const step = withInputs.steps[i]!;
    if (step.action.kind !== "workflow" || !step.id) continue;
    const child = children.get(step.action.name)!;
    childReturnsById.set(step.id, child.returns);
  }

  const parentInputs = withInputs.inputs;
  const profiles = new Set(profileNames(scope.config));
  const producers = assertWorkflowReferences(
    withInputs.file,
    withInputs,
    childReturnsById,
    profiles,
  );

  for (let i = 0; i < withInputs.steps.length; i++) {
    const step = withInputs.steps[i]!;
    if (step.action.kind !== "workflow") continue;
    const child = children.get(step.action.name)!;
    assertChildInputContract(
      withInputs.file,
      i + 1,
      step.action.inputs,
      child,
      producers,
      parentInputs,
      profiles,
      step.when ?? [],
    );
  }
  if (withInputs.onFailure?.kind === "workflow") {
    const child = children.get(withInputs.onFailure.name)!;
    assertChildInputContract(
      withInputs.file,
      undefined,
      withInputs.onFailure.inputs,
      child,
      producers,
      parentInputs,
      profiles,
    );
  }

  return withInputs;
}

export async function parseWorkflowText(
  name: string,
  yaml: string,
  config: WorkflowsConfig = EMPTY_CONFIG,
  repoRoot: string = process.cwd(),
  file = `${name}.yaml`,
): Promise<LoadedWorkflow> {
  const workflow = loadFromRaw(name, file, "repo", parseRaw(file, yaml));
  return finalizeWorkflow(workflow, {
    repoRoot,
    config,
    stack: [name],
    cache: new Map(),
  });
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadWorkflowEntry({ name, ...resolved }, repoRoot, config);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<LoadedWorkflow> {
  if (!(await Bun.file(entry.file).exists())) {
    bail(entry.file, undefined, undefined, "file not found");
  }
  const cfg = config ?? (await loadConfig(repoRoot));
  const raw = parseRaw(entry.file, await Bun.file(entry.file).text());
  const workflow = loadFromRaw(entry.name, entry.file, entry.source, raw);
  return finalizeWorkflow(workflow, {
    repoRoot,
    config: cfg,
    stack: [entry.name],
    cache: new Map(),
  });
}

export async function listWorkflows(
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<WorkflowListEntry[]> {
  const cfg = config ?? (await loadConfig(repoRoot));
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const workflow = await loadWorkflowEntry(entry, repoRoot, cfg);
      entry.hidden = workflow.hidden;
      entry.title = workflow.title;
      entry.description = workflow.description;
      entry.needsTranscript = workflow.needsTranscript;
      entry.inputs = workflow.inputs;
      entry.repoOwned = workflow.repoOwned;
      entry.dynamicOptions = workflow.inputs.some((input) => input.dynamicOptions !== undefined);
      const flags = await analyzeResolvedSensitivity(
        {
          name: workflow.name,
          steps: workflow.steps,
          returns: workflow.returns,
          onFailure: workflow.onFailure,
        },
        repoRoot,
      );
      entry.hasCommands = flags.hasCommands;
      entry.needsTranscript = flags.hasTranscript || workflow.needsTranscript;
      entry.sensitiveMethods = flags.sensitiveMethods;
      entry.unresolvedChildren = flags.unresolvedChildren;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
