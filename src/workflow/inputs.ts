import {
  globalConfigPath,
  noProfilesConfiguredMessage,
  profileNames,
  repoConfigPath,
  type WorkflowsConfig,
} from "../context";
import { CaptureLimitError, latest } from "../context";
import { evaluateWhen } from "./conditions";
import {
  bail,
  type DynamicChoice,
  type InputSpec,
  type LoadedWorkflow,
  type TemplateNamespace,
} from "./types";

export { evaluateWhen } from "./conditions";

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
