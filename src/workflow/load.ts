import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, profileNames, resolveProfile, type WorkflowsConfig } from "../config";
import { CaptureLimitError } from "../limits";
import { spawnCapture } from "../run/steps/shell";
import {
  parseRaw,
  workflowNeedsInvokingAgent,
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

const DYNAMIC_CHOICE_TIMEOUT_MS = 10_000;
const DYNAMIC_CHOICE_MAX = 1_000;
const STDERR_TAIL = 500;

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

function shellUsesInput(command: string, name: string): boolean {
  return command.includes(`HWF_${name}`);
}

function inputIsUsed(
  name: string,
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
): boolean {
  const refs = workflowTemplateRefs(steps, returns, onFailure);
  if (refs.some((p) => p.root === "inputs" && p.segments[0] === name)) return true;
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
      maxStdoutBytes: { source: `inputs.${name} dynamic choice` },
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
  if (type === "choice") {
    if (!raw.options) {
      bail(file, undefined, `inputs.${name}`, "choice input requires options");
    }
    if (Array.isArray(raw.options)) {
      return {
        name,
        type: "choice",
        description: raw.description,
        default: raw.default,
        options: raw.options,
      };
    }
    return {
      name,
      type: "choice",
      description: raw.description,
      default: raw.default,
      dynamicOptions: raw.options as DynamicChoice,
    };
  }
  return {
    name,
    type,
    description: raw.description,
    default: raw.default,
  };
}

function inputsOf(file: string, raw: RawWorkflow): InputSpec[] {
  return Object.entries(raw.inputs ?? {}).map(([name, value]) => resolveInput(file, name, value));
}

function assertInputsUsed(file: string, workflow: LoadedWorkflow): void {
  for (const input of workflow.inputs) {
    if (!inputIsUsed(input.name, workflow.steps, workflow.returns, workflow.onFailure)) {
      bail(file, undefined, `inputs.${input.name}`, "unused input");
    }
  }
}

function assertDefaultInOptions(file: string, input: InputSpec): void {
  if (input.default === undefined || input.options === undefined) return;
  if (!input.options.includes(input.default)) {
    bail(
      file,
      undefined,
      `inputs.${input.name}.default`,
      `default '${input.default}' is not in available values`,
    );
  }
}

async function finalizeInputs(
  file: string,
  inputs: InputSpec[],
  config: WorkflowsConfig,
  repoRoot: string,
  resolveDynamic: boolean,
): Promise<InputSpec[]> {
  const profiles = profileNames(config);
  const out: InputSpec[] = [];
  for (const input of inputs) {
    if (input.type === "profile") {
      const next: InputSpec = { ...input, options: profiles };
      if (next.default !== undefined && !resolveProfile(config, next.default)) {
        bail(
          file,
          undefined,
          `inputs.${input.name}.default`,
          `default '${next.default}' is not in available values`,
        );
      }
      assertDefaultInOptions(file, next);
      out.push(next);
      continue;
    }
    if (input.type === "choice" && input.dynamicOptions) {
      if (!resolveDynamic) {
        out.push(input);
        continue;
      }
      const options = await resolveDynamicChoices(file, input.name, input.dynamicOptions, repoRoot);
      const next: InputSpec = {
        name: input.name,
        type: "choice",
        description: input.description,
        default: input.default,
        options,
      };
      assertDefaultInOptions(file, next);
      out.push(next);
      continue;
    }
    if (input.type === "choice") assertDefaultInOptions(file, input);
    out.push(input);
  }
  return out;
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
    needsInvokingAgent: workflowNeedsInvokingAgent(raw.steps),
  };
}

async function finalizeWorkflow(
  workflow: LoadedWorkflow,
  config: WorkflowsConfig,
  repoRoot: string,
  resolveDynamic: boolean,
): Promise<LoadedWorkflow> {
  assertInputsUsed(workflow.file, workflow);
  const inputs = await finalizeInputs(
    workflow.file,
    workflow.inputs,
    config,
    repoRoot,
    resolveDynamic,
  );
  return { ...workflow, inputs };
}

const EMPTY_CONFIG: WorkflowsConfig = { profiles: {}, transcripts: {} };

export async function parseWorkflowText(
  name: string,
  yaml: string,
  config: WorkflowsConfig | Iterable<string> = EMPTY_CONFIG,
  repoRoot: string = process.cwd(),
  file = `${name}.yaml`,
  resolveDynamic = true,
): Promise<LoadedWorkflow> {
  const cfg = iterableToConfig(config);
  const workflow = loadFromRaw(name, file, "repo", parseRaw(file, yaml));
  return finalizeWorkflow(workflow, cfg, repoRoot, resolveDynamic);
}

function isWorkflowsConfig(value: unknown): value is WorkflowsConfig {
  return !!value && typeof value === "object" && !Array.isArray(value) && "profiles" in value;
}

function iterableToConfig(config: WorkflowsConfig | Iterable<string>): WorkflowsConfig {
  if (isWorkflowsConfig(config)) {
    return {
      profiles: config.profiles,
      ...(config.default_profile !== undefined ? { default_profile: config.default_profile } : {}),
      transcripts: config.transcripts ?? {},
    };
  }
  const profiles: WorkflowsConfig["profiles"] = {};
  for (const name of config) {
    profiles[name] = { kind: name };
  }
  return { profiles, transcripts: {} };
}

async function resolveConfig(
  repoRoot: string,
  config?: WorkflowsConfig | Iterable<string>,
): Promise<WorkflowsConfig> {
  if (config === undefined) return loadConfig(repoRoot);
  return iterableToConfig(config);
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  config?: WorkflowsConfig | Iterable<string>,
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadWorkflowEntry({ name, ...resolved }, repoRoot, config, true);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  repoRoot: string,
  config?: WorkflowsConfig | Iterable<string>,
  resolveDynamic = true,
): Promise<LoadedWorkflow> {
  if (!(await Bun.file(entry.file).exists())) {
    bail(entry.file, undefined, undefined, "file not found");
  }
  const cfg = await resolveConfig(repoRoot, config);
  const raw = parseRaw(entry.file, await Bun.file(entry.file).text());
  const workflow = loadFromRaw(entry.name, entry.file, entry.source, raw);
  return finalizeWorkflow(workflow, cfg, repoRoot, resolveDynamic);
}

export async function listWorkflows(
  repoRoot: string,
  config?: WorkflowsConfig | Iterable<string>,
): Promise<WorkflowListEntry[]> {
  const cfg = await resolveConfig(repoRoot, config);
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const workflow = await loadWorkflowEntry(entry, repoRoot, cfg, false);
      entry.hidden = workflow.hidden;
      entry.needsTranscript = workflow.needsTranscript;
      entry.inputs = workflow.inputs;
      entry.repoOwned = workflow.repoOwned;
      entry.dynamicOptions = workflow.inputs.some((input) => input.dynamicOptions !== undefined);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
