import { join } from "node:path";
import { homedir } from "node:os";
import {
  assertChildInputContract,
  assertWorkflowReferences,
  shellUsesInput,
  workflowChildNames,
} from "./validate";
import {
  CaptureLimitError,
  workflowSchemaUrl,
  globalConfigPath,
  noProfilesConfiguredMessage,
  profileNames,
  repoConfigPath,
  latest,
  loadConfig,
  type WorkflowsConfig,
} from "../context";
import {
  resolveWorkflowFile,
  workflowPath,
  parseRaw,
  rawStepKeyOrder,
  WorkflowLoadError,
  evaluateWhen,
  bail,
  parseWhenClause,
  workflowNeedsTranscript,
  workflowTemplateRefs,
  analyzeResolvedSensitivity,
  type RawStep,
  type RawWorkflowDoc,
  type DynamicChoice,
  type InputSpec,
  type LoadedWorkflow,
  type TemplateNamespace,
  type RawWorkflow,
  type RawInputValue,
  type RecoveryAction,
  type ReturnsSpec,
  type WorkflowListEntry,
  type WorkflowStep,
} from "./grammar";

const SCHEMA_POINTER_RE = /^#\s*yaml-language-server:\s*\$schema=\S+\s*$/;

export function schemaPointer(): string {
  return `# yaml-language-server: $schema=${workflowSchemaUrl()}`;
}

/**
 * Give workflow text a schema pointer for the contract this build implements. Any pointer already
 * present is replaced wherever it sits, so a file authored against another version cannot end up
 * carrying two contradictory pointers. Text already pinned is returned byte-identical.
 */
export function withPinnedSchemaPointer(text: string): string {
  const pointer = schemaPointer();
  if (text.length === 0) return `${pointer}\n`;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !SCHEMA_POINTER_RE.test(line));
  if (kept.length === lines.length - 1 && lines[0] === pointer) return text;
  return [pointer, ...kept].join("\n");
}

const IND = "  ";
const ACTION_KEYS = new Set(["agent", "run", "herdr", "workflow", "params"]);
const SCHEMA_KEYS = new Set(rawStepKeyOrder);

function scalar(v: string): string {
  return Bun.YAML.stringify(v);
}

function blockSafe(v: string): boolean {
  return v.split("\n").every((ln) => ln === ln.trim() || ln === "");
}

function field(lines: string[], indent: string, key: string, v: string): void {
  if (v.includes("\n")) {
    if (!v.endsWith("\n") && blockSafe(v)) {
      lines.push(`${indent}${key}: |-`);
      for (const ln of v.split("\n")) lines.push(`${indent}${IND}${ln}`);
      return;
    }
    lines.push(`${indent}${key}: ${scalar(v)}`);
    return;
  }
  lines.push(`${indent}${key}: ${scalar(v)}`);
}

function dumpValue(lines: string[], indent: string, key: string, value: unknown): void {
  if (typeof value === "string") field(lines, indent, key, value);
  else if (value !== undefined) lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
}

function dumpActionLines(step: RawStep, indent: string): string[] {
  const m: string[] = [];
  if (typeof step.agent === "string") {
    field(m, indent, "agent", step.agent);
  } else if (typeof step.run === "string") {
    field(m, indent, "run", step.run);
  } else if (Array.isArray(step.run)) {
    m.push(`${indent}run: ${JSON.stringify(step.run)}`);
  } else if (typeof step.herdr === "string") {
    field(m, indent, "herdr", step.herdr);
    if (step.params && typeof step.params === "object") {
      m.push(`${indent}params: ${JSON.stringify(step.params)}`);
    }
  } else if (typeof step.workflow === "string") {
    field(m, indent, "workflow", step.workflow);
  } else {
    m.push(`${indent}run: ""`);
  }
  for (const key of rawStepKeyOrder) {
    if (ACTION_KEYS.has(key)) continue;
    const value = (step as Record<string, unknown>)[key];
    if (value !== undefined) dumpValue(m, indent, key, value);
  }
  for (const [key, value] of Object.entries(step)) {
    if (SCHEMA_KEYS.has(key) || value === undefined) continue;
    dumpValue(m, indent, key, value);
  }
  if (m.length === 0) m.push(`${indent}run: ""`);
  return m;
}

function dumpStep(step: RawStep): string[] {
  const I = IND + IND;
  const m = dumpActionLines(step, I);
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
}

/** `on_failure` is a mapping, not a list item. */
function dumpRecovery(step: RawStep): string[] {
  return dumpActionLines(step, IND);
}

function dumpInputs(lines: string[], inputs: NonNullable<RawWorkflowDoc["inputs"]>): void {
  lines.push("inputs:");
  for (const [name, inp] of Object.entries(inputs)) {
    if (typeof inp === "string") {
      lines.push(`${IND}${scalar(name)}: ${scalar(inp)}`);
      continue;
    }
    if (Array.isArray(inp)) {
      lines.push(`${IND}${scalar(name)}: ${JSON.stringify(inp)}`);
      continue;
    }
    lines.push(`${IND}${scalar(name)}:`);
    if (inp.type !== undefined) lines.push(`${IND}${IND}type: ${inp.type}`);
    if (inp.description !== undefined)
      lines.push(`${IND}${IND}description: ${scalar(inp.description)}`);
    if (inp.options !== undefined) {
      if (Array.isArray(inp.options)) {
        lines.push(`${IND}${IND}options:`);
        for (const o of inp.options) lines.push(`${IND}${IND}${IND}- ${scalar(o)}`);
      } else {
        lines.push(`${IND}${IND}options: ${JSON.stringify(inp.options)}`);
      }
    }
    if (inp.default !== undefined) lines.push(`${IND}${IND}default: ${scalar(inp.default)}`);
    if (inp.when !== undefined) lines.push(`${IND}${IND}when: ${JSON.stringify(inp.when)}`);
    if (inp.allow_custom !== undefined) {
      lines.push(`${IND}${IND}allow_custom: ${String(inp.allow_custom)}`);
    }
    if (inp.min_length !== undefined) lines.push(`${IND}${IND}min_length: ${inp.min_length}`);
  }
}

export function dumpWorkflow(doc: RawWorkflowDoc): string {
  const lines: string[] = [];
  lines.push(schemaPointer());
  lines.push(`version: ${scalar(doc.version)}`);
  if (doc.title) {
    field(lines, "", "title", doc.title);
  }
  if (doc.description) {
    field(lines, "", "description", doc.description);
  }
  if (doc.hidden === true) lines.push("hidden: true");
  if (doc.inputs && Object.keys(doc.inputs).length > 0) {
    lines.push("");
    dumpInputs(lines, doc.inputs);
  }
  if (doc.returns !== undefined) {
    lines.push("");
    if (typeof doc.returns === "string") field(lines, "", "returns", doc.returns);
    else lines.push(`returns: ${JSON.stringify(doc.returns)}`);
  }
  lines.push("");
  lines.push("steps:");
  doc.steps.forEach((step, i) => {
    if (i > 0) lines.push("");
    lines.push(...dumpStep(step));
  });
  if (doc.on_failure) {
    lines.push("");
    lines.push("on_failure:");
    lines.push(...dumpRecovery(doc.on_failure as RawStep));
  }
  return `${lines.join("\n")}\n`;
}

export { evaluateWhen };

const DYNAMIC_CHOICE_TIMEOUT_MS = 10_000;
const DYNAMIC_CHOICE_MAX = 1_000;
const STDERR_TAIL = 500;

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
  const { spawnCapture } = await import("../engine");
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

export type CollectedInputs =
  | { ok: true; values: Record<string, string>; domains: Record<string, string[]> }
  | { ok: false; error: string };

type ActivePrompt = {
  index: number;
  spec: InputSpec;
  options?: string[];
};

type CurrentPromptResult =
  | { status: "prompt"; prompt: ActivePrompt }
  | { status: "done" }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export type InputSession = {
  current(): Promise<CurrentPromptResult>;
  answer(value: string): { ok: true } | { ok: false; error: string };
  back(): boolean;
  result(): CollectedInputs;
  /** Headless driver: apply provided/default values through the session. */
  completeFromProvided(provided?: Record<string, string>): Promise<CollectedInputs>;
  cancelPending(): void;
  readonly values: Record<string, string>;
  readonly domains: Record<string, string[]>;
  readonly cursor: number;
};

export type CreateInputSessionOpts = {
  specs: InputSpec[];
  file: string;
  config: WorkflowsConfig;
  repoRoot: string;
  answers?: Record<string, string>;
  domains?: Record<string, string[]>;
  resolveDynamic?: boolean;
};

function optionsForSpec(spec: InputSpec, domains: Record<string, string[]>): string[] | undefined {
  if (domains[spec.name]) return domains[spec.name];
  if (spec.options) return spec.options;
  return undefined;
}

async function resolveActiveOptions(
  spec: InputSpec,
  opts: CreateInputSessionOpts,
  domains: Record<string, string[]>,
): Promise<{ ok: true; options?: string[]; cache?: boolean } | { ok: false; error: string }> {
  if (spec.type === "profile") {
    const profiles = profileNames(opts.config);
    if (profiles.length === 0) {
      return {
        ok: false,
        error: `input '${spec.name}': ${noProfilesConfiguredMessage(
          await globalConfigPath(),
          repoConfigPath(opts.repoRoot),
        )}`,
      };
    }
    return { ok: true, options: profiles };
  }
  if (spec.type !== "choice") return { ok: true };
  const existing = optionsForSpec(spec, domains);
  if (existing) return { ok: true, options: existing };
  if (!spec.dynamicOptions) {
    return { ok: false, error: `input '${spec.name}': choice produced no options` };
  }
  if (opts.resolveDynamic === false) {
    return {
      ok: false,
      error: `input '${spec.name}': missing launch payload domain snapshot`,
    };
  }
  try {
    const options = await resolveDynamicChoices(
      opts.file,
      spec.name,
      spec.dynamicOptions,
      opts.repoRoot,
    );
    return { ok: true, options, cache: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateActiveValue(
  spec: InputSpec,
  value: string,
  options: string[] | undefined,
): string | undefined {
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    return `input '${spec.name}' must be at least ${spec.minLength} characters`;
  }
  if (spec.type === "profile") {
    if (!options?.includes(value)) {
      return `input '${spec.name}' must be one of: ${(options ?? []).join(", ")}`;
    }
    return undefined;
  }
  if (spec.type === "choice" && options) {
    if (!spec.allowCustom && !options.includes(value)) {
      return `input '${spec.name}' must be one of: ${options.join(", ")}`;
    }
  }
  return undefined;
}

/** Next active input given answers collected so far. */
function nextActiveInput(
  specs: InputSpec[],
  values: Record<string, string>,
  fromIndex = 0,
): { index: number; spec: InputSpec } | undefined {
  const ns: TemplateNamespace = { inputs: values, steps: {}, context: {} };
  for (let i = fromIndex; i < specs.length; i++) {
    const spec = specs[i]!;
    if (evaluateWhen(spec.when, ns)) return { index: i, spec };
  }
  return undefined;
}

function previousActiveIndex(
  specs: InputSpec[],
  values: Record<string, string>,
  beforeIndex: number,
): number | undefined {
  const kept: Record<string, string> = {};
  let last: number | undefined;
  for (let i = 0; i < beforeIndex; i++) {
    const probe = nextActiveInput(specs, kept, i);
    if (!probe || probe.index !== i) continue;
    const spec = specs[i]!;
    if (Object.hasOwn(values, spec.name)) kept[spec.name] = values[spec.name]!;
    last = i;
  }
  return last;
}

function emptyOptionsError(spec: InputSpec): string {
  return spec.type === "profile"
    ? `input '${spec.name}': no profiles configured; run \`hwf init\` or \`hwf init --global\``
    : `input '${spec.name}': choice produced no options`;
}

export function createInputSession(opts: CreateInputSessionOpts): InputSession {
  const specs = opts.specs;
  const values: Record<string, string> = { ...(opts.answers ?? {}) };
  const domains: Record<string, string[]> = { ...(opts.domains ?? {}) };
  const suppliedDomains = new Set(Object.keys(opts.domains ?? {}));
  const usedDomains = new Set<string>();
  const resolveToken = latest();
  let cursor = 0;
  let pending: ActivePrompt | undefined;

  const session: InputSession = {
    get values() {
      return values;
    },
    get domains() {
      return domains;
    },
    get cursor() {
      return cursor;
    },
    cancelPending() {
      resolveToken.bump();
      pending = undefined;
    },
    back() {
      const prev = previousActiveIndex(specs, values, cursor);
      if (prev === undefined) return false;
      resolveToken.bump();
      for (const spec of specs.slice(prev + 1)) {
        delete values[spec.name];
        delete domains[spec.name];
      }
      cursor = prev;
      pending = undefined;
      return true;
    },
    answer(value: string) {
      if (!pending) return { ok: false, error: "no active input" };
      const err = validateActiveValue(pending.spec, value, pending.options);
      if (err) return { ok: false, error: err };
      for (const later of specs.slice(pending.index + 1)) {
        delete values[later.name];
        delete domains[later.name];
      }
      values[pending.spec.name] = value;
      cursor = pending.index + 1;
      pending = undefined;
      return { ok: true };
    },
    async current() {
      const token = resolveToken.begin();
      const next = nextActiveInput(specs, values, cursor);
      if (!next) return { status: "done" };
      cursor = next.index;
      if (Object.hasOwn(domains, next.spec.name)) usedDomains.add(next.spec.name);
      const resolved = await resolveActiveOptions(next.spec, opts, domains);
      if (!resolveToken.current(token)) return { status: "cancelled" };
      if (!resolved.ok) return { status: "error", error: resolved.error };
      if (resolved.options !== undefined && resolved.options.length === 0) {
        return { status: "error", error: emptyOptionsError(next.spec) };
      }
      if (resolved.cache && resolved.options) domains[next.spec.name] = resolved.options;
      if (Object.hasOwn(domains, next.spec.name)) usedDomains.add(next.spec.name);
      pending = { index: next.index, spec: next.spec, options: resolved.options };
      return { status: "prompt", prompt: pending };
    },
    result() {
      for (const name of suppliedDomains) {
        if (!usedDomains.has(name)) {
          return {
            ok: false,
            error: `launch payload domain '${name}' belongs to an inactive or non-dynamic input`,
          };
        }
      }
      if (nextActiveInput(specs, values, cursor)) {
        return { ok: false, error: "input collection is incomplete" };
      }
      return { ok: true, values: { ...values }, domains: { ...domains } };
    },
    async completeFromProvided(provided = {}) {
      const declared = new Set(specs.map((spec) => spec.name));
      for (const name of Object.keys(provided)) {
        if (!declared.has(name)) return { ok: false, error: `unknown input '${name}'` };
      }
      for (const name of Object.keys(opts.domains ?? {})) {
        const spec = specs.find((row) => row.name === name);
        if (!spec || spec.type !== "choice" || !spec.dynamicOptions) {
          return {
            ok: false,
            error: `launch payload domain '${name}' must name a declared dynamic choice input`,
          };
        }
      }

      for (;;) {
        const cur = await session.current();
        if (cur.status === "cancelled") return { ok: false, error: "input collection cancelled" };
        if (cur.status === "error") return { ok: false, error: cur.error };
        if (cur.status === "done") break;
        const name = cur.prompt.spec.name;
        const value = Object.hasOwn(provided, name) ? provided[name]! : cur.prompt.spec.default;
        if (value === undefined) {
          return { ok: false, error: `missing input '${name}' (--input ${name}=…)` };
        }
        const answered = session.answer(value);
        if (!answered.ok) return answered;
      }

      for (const name of Object.keys(provided)) {
        if (!Object.hasOwn(session.values, name)) {
          return {
            ok: false,
            error: `input '${name}' is inactive under current answers`,
          };
        }
      }

      return session.result();
    },
  };
  return session;
}

/** Engine entry: bind a loaded workflow and drive the session headlessly. */
export async function completeWorkflowInputs(
  workflow: LoadedWorkflow,
  opts: Omit<CreateInputSessionOpts, "specs" | "file"> & {
    provided?: Record<string, string>;
  },
): Promise<CollectedInputs> {
  const session = createInputSession({
    specs: workflow.inputs,
    file: workflow.file,
    config: opts.config,
    repoRoot: opts.repoRoot,
    ...(opts.answers !== undefined ? { answers: opts.answers } : {}),
    ...(opts.domains !== undefined ? { domains: opts.domains } : {}),
    ...(opts.resolveDynamic !== undefined ? { resolveDynamic: opts.resolveDynamic } : {}),
  });
  return session.completeFromProvided(opts.provided);
}

export { parseRaw, parseRawWithDoc, rawWorkflowSchema } from "./grammar";
export { workflowPath } from "./grammar";
export { buildTemplateNamespace, workflowTemplateRefs } from "./grammar";
export {
  analyzeResolvedSensitivity,
  analyzeYamlTree,
  sensitivityLabels,
  workflowDisplayTitle,
} from "./grammar";

const EMPTY_CONFIG: WorkflowsConfig = { profiles: {}, transcripts: {} };

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
