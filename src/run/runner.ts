import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentLabel,
  agentStatus,
  HerdrError,
  herdrCall,
  layoutApply,
  notificationShow,
  paneClose,
  paneRead,
  reportToken,
  tabClose,
  waitOutput,
} from "../herdr";
import {
  buildPlaceholders,
  type AgentsConfig,
  type InvocationContext,
  type SessionsConfig,
} from "../config";
import { appendRunLog } from "../runlog";
import { sessionText } from "../session";
import type {
  FlatStep,
  Guard,
  InputSpec,
  LoadedWorkflow,
  PlaceholderValues,
} from "../workflow/types";
import { substitute } from "../workflow/parse";
import { loadWorkflow } from "../workflow/load";
import { agentStep } from "./steps/agent";
import { bindIncludeRunSteps, includeStep } from "./steps/include";
import { primitiveStep } from "./steps/primitive";
import { runArgvStep, runShellStep, shellStep } from "./steps/shell";

export type RunnerDeps = {
  layoutApply: typeof layoutApply;
  herdrCall: typeof herdrCall;
  notificationShow: typeof notificationShow;
  runShell: typeof runShellStep;
  runArgv: typeof runArgvStep;
  agentStatus: typeof agentStatus;
  agentLabel: typeof agentLabel;
  waitOutput: typeof waitOutput;
  paneRead: typeof paneRead;
  paneClose: typeof paneClose;
  reportToken: typeof reportToken;
  sessionText: typeof sessionText;
  tabClose: typeof tabClose;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  agentWaitPollMs?: number;
  agentWaitIdleGraceMs?: number;
};

type StepRunOptions = {
  name: string;
  agents: AgentsConfig;
  ctx: InvocationContext;
  deps: RunnerDeps;
  runId: string;
  onProgress?: (
    step: number,
    total: number,
    label: string,
    outcome?: "ok" | "skip" | "fail",
  ) => void;
  onStderr?: (text: string) => void;
};

type StepResult =
  | { ok: true; skipped?: boolean; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      /** true when a non-allow_fail step aborted */ aborted?: boolean;
      /** true when the failure was the HWF_ env size cap */
      envOverflow?: boolean;
    };

type StepContext = {
  step: FlatStep;
  values: PlaceholderValues;
  env: NodeJS.ProcessEnv;
  opts: StepRunOptions;
  index: number;
};

type StepOutcome =
  | { ok: true; bindings?: Record<string, string>; failures?: string[] }
  | { ok: false; error: string; failures?: string[] };

type StepRunner = (c: StepContext) => Promise<StepOutcome>;

const RUNNERS: Record<FlatStep["action"]["kind"], StepRunner> = {
  run: shellStep as StepRunner,
  agent: agentStep as StepRunner,
  primitive: primitiveStep as StepRunner,
  include: includeStep as StepRunner,
};

function defaultDeps(): RunnerDeps {
  return {
    layoutApply,
    herdrCall,
    notificationShow,
    runShell: runShellStep,
    runArgv: runArgvStep,
    agentStatus,
    agentLabel,
    waitOutput,
    paneRead,
    paneClose,
    reportToken,
    sessionText,
    tabClose,
  };
}

async function fail(
  deps: RunnerDeps,
  workflow: string,
  step: number,
  detail: string,
): Promise<string> {
  const text = `step ${step}: ${detail}`;
  const body = text.length > 500 ? `…${text.slice(-500)}` : text;
  await deps.notificationShow(`herdr-workflows: ${workflow} failed`, body).catch(() => undefined);
  return body;
}

export type ResolvedInputs =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/** Merge provided values with declared defaults; reject unknown, missing, and out-of-set values. */
export function resolveInputValues(
  specs: InputSpec[],
  provided: Record<string, string> = {},
): ResolvedInputs {
  const declared = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) return { ok: false, error: `unknown input '${name}'` };
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const spec of specs) {
    const value = Object.hasOwn(provided, spec.name) ? provided[spec.name] : spec.default;
    if (value === undefined) {
      return { ok: false, error: `missing input '${spec.name}' (--input ${spec.name}=…)` };
    }
    if (spec.options && !spec.options.includes(value)) {
      return {
        ok: false,
        error: `input '${spec.name}' must be one of: ${spec.options.join(", ")}`,
      };
    }
    values[spec.name] = value;
  }
  return { ok: true, values };
}

type Preflight =
  | { ok: true; session: string; sessionFailure?: string; agent: string }
  | { ok: false; error: string };

/** Resolve {session} and {agent} preconditions; session extraction failure is non-fatal. */
async function resolvePreflight(
  workflow: LoadedWorkflow,
  ctx: InvocationContext,
  agents: Record<string, string[]>,
  sessions: SessionsConfig,
  deps: RunnerDeps,
): Promise<Preflight> {
  let session = "";
  // Extraction failure aborts before steps and does not trigger on_error.
  let sessionFailure: string | undefined;
  if (workflow.needsSession) {
    if (!ctx.paneId) {
      return { ok: false, error: "session handoff must be launched from an agent pane" };
    }
    try {
      session = await deps.sessionText(ctx.paneId, sessions);
    } catch (err) {
      sessionFailure = err instanceof Error ? err.message : String(err);
    }
  }

  let agent = "";
  if (workflow.needsInvokingAgent) {
    if (!ctx.paneId) {
      return { ok: false, error: "invoking agent unresolved — run from agent pane" };
    }
    try {
      const label = await deps.agentLabel(ctx.paneId);
      if (!agents[label]) {
        return {
          ok: false,
          error: `invoking agent '${label}' not in config — add it under agents:`,
        };
      }
      agent = label;
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "invoking agent unresolved — run from agent pane",
      };
    }
  }
  return { ok: true, session, sessionFailure, agent };
}

const FOR_CAP = 100;

async function evalGuard(
  guard: Guard,
  values: PlaceholderValues,
  opts: StepRunOptions,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (guard.kind === "nonempty") {
    const v = values[guard.name] ?? "";
    const nonempty = v.length > 0;
    return guard.negate ? !nonempty : nonempty;
  }
  if (guard.kind === "eq") {
    const equal = (values[guard.name] ?? "") === guard.value;
    return guard.negate ? !equal : equal;
  }
  if (guard.kind === "argv") {
    const argv = guard.argv.map((el) => substitute(el, values));
    const result = await opts.deps.runArgv(argv, { cwd: opts.ctx.cwd, env });
    return result.ok;
  }
  const result = await opts.deps.runShell(guard.command, { cwd: opts.ctx.cwd, env });
  return result.ok;
}

async function resolveForItems(
  step: FlatStep,
  values: PlaceholderValues,
  opts: StepRunOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; items: string[] } | { ok: false; error: string }> {
  if (!step.for) return { ok: true, items: [""] };
  let items: string[];
  if (step.for.kind === "list") items = step.for.items;
  else if (step.for.kind === "binding") {
    items = (values[step.for.name] ?? "").split("\n").filter((l) => l.length > 0);
  } else {
    const result = await opts.deps.runShell(step.for.command, { cwd: opts.ctx.cwd, env });
    if (!result.ok) {
      return { ok: false, error: result.stderr.trim() || "for: command failed" };
    }
    items = result.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  }
  if (items.length > FOR_CAP) {
    return {
      ok: false,
      error: `for: resolved ${items.length} items — cap is ${FOR_CAP}`,
    };
  }
  return { ok: true, items };
}

function bindSkippedOuts(step: FlatStep, values: PlaceholderValues): void {
  if (step.action.kind === "include") {
    for (const name of step.action.exportedOuts) values[name] = "";
  }
  if (!step.out) return;
  if (step.out.kind === "text") {
    values[step.out.name] = "";
    return;
  }
  for (const name of Object.keys(step.out.fields)) values[name] = "";
}

function stepLabel(step: FlatStep): string {
  if (step.name) return step.name;
  const a = step.action;
  if (a.kind === "run") {
    if (a.payload.form === "argv") return `run: ${a.payload.argv.join(" ")}`;
    return `run: ${a.payload.command.split("\n")[0]}`;
  }
  if (a.kind === "agent") return `agent: ${a.agent}`;
  if (a.kind === "primitive") return a.method;
  return `use: ${a.workflow}`;
}

class EnvSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvSizeError";
  }
}

// Headroom under the ~32 KB Windows env-block ceiling, the tightest spawn limit anywhere.
const HWF_ENV_CAP_BYTES = 24 * 1024;

function namespaceEnv(values: PlaceholderValues): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let total = 0;
  for (const [name, value] of Object.entries(values)) {
    // session holds a whole transcript — too big for env; {session_file} is the shell path.
    if (name === "session" || value === undefined) continue;
    const bytes = Buffer.byteLength(`HWF_${name}`) + Buffer.byteLength(value);
    total += bytes;
    if (total > HWF_ENV_CAP_BYTES) {
      throw new EnvSizeError(
        `HWF_${name} is ${Math.ceil(Buffer.byteLength(value) / 1024)} KB, environment block too large for spawn`,
      );
    }
    env[`HWF_${name}`] = value;
  }
  return env;
}

type FailedStep = { ok: false; error: string };

type StepExec = {
  skipped?: boolean;
  failed?: FailedStep;
  failures?: string[];
  envOverflow?: boolean;
};

async function logStep(
  opts: StepRunOptions,
  n: number,
  total: number,
  label: string,
  error?: string,
  skipped?: boolean,
): Promise<void> {
  await appendRunLog({
    ts: new Date().toISOString(),
    run: opts.runId,
    workflow: opts.name,
    step: n,
    total,
    label,
    ok: error === undefined,
    ...(skipped ? { skipped: true } : {}),
    ...(error === undefined ? {} : { error }),
  });
}

async function runActionOnce(
  step: FlatStep,
  opts: StepRunOptions,
  values: PlaceholderValues,
  n: number,
  env: NodeJS.ProcessEnv,
): Promise<StepExec> {
  try {
    const outcome = await RUNNERS[step.action.kind]({
      step,
      values,
      env,
      opts,
      index: n,
    });
    if (!outcome.ok) {
      // include child failures already went through fail(); wrap others.
      const error =
        step.action.kind === "include"
          ? outcome.error
          : await fail(opts.deps, opts.name, n, outcome.error);
      return { failed: { ok: false, error }, failures: outcome.failures };
    }
    if (outcome.bindings) {
      for (const [k, v] of Object.entries(outcome.bindings)) values[k] = v;
    }
    return { failures: outcome.failures };
  } catch (error) {
    const detail =
      error instanceof HerdrError || error instanceof Error ? error.message : String(error);
    return { failed: { ok: false, error: await fail(opts.deps, opts.name, n, detail) } };
  }
}

async function runWithRetry(
  step: FlatStep,
  opts: StepRunOptions,
  values: PlaceholderValues,
  n: number,
  env: NodeJS.ProcessEnv,
): Promise<StepExec> {
  const times = step.retry?.times ?? 1;
  let lastFail: FailedStep | undefined;
  for (let attempt = 1; attempt <= times; attempt++) {
    values.attempt = String(attempt);
    const exec = await runActionOnce(step, opts, values, n, env);
    if (exec.failed) {
      lastFail = exec.failed;
    } else if (step.retry?.until) {
      const ok = await evalGuard(step.retry.until, values, opts, env);
      if (!ok) {
        lastFail = {
          ok: false,
          error: await fail(opts.deps, opts.name, n, "retry until: guard failed"),
        };
      } else {
        return exec;
      }
    } else {
      return exec;
    }
    if (attempt < times) {
      if (step.retry?.reset) {
        await opts.deps.runShell(step.retry.reset, { cwd: opts.ctx.cwd, env });
      }
      if (step.retry?.delaySec) {
        await (opts.deps.sleep ?? ((ms) => Bun.sleep(ms)))(step.retry.delaySec * 1000);
      }
    }
  }
  return lastFail ? { failed: lastFail } : {};
}

async function runOneStep(
  step: FlatStep,
  opts: StepRunOptions,
  values: PlaceholderValues,
  n: number,
  total: number,
): Promise<StepExec> {
  const label = stepLabel(step);
  try {
    return await execOneStep(step, opts, values, n, total, label);
  } catch (error) {
    if (!(error instanceof EnvSizeError)) throw error;
    const message = await fail(opts.deps, opts.name, n, error.message);
    opts.onProgress?.(n, total, label, "fail");
    await logStep(opts, n, total, label, message);
    return { failed: { ok: false, error: message }, envOverflow: true };
  }
}

async function execOneStep(
  step: FlatStep,
  opts: StepRunOptions,
  values: PlaceholderValues,
  n: number,
  total: number,
  label: string,
): Promise<StepExec> {
  // Rebuilt per step (and per item) so `out:` bindings from earlier steps reach HWF_<name>.
  // nonempty/eq guards need no env — skip before the env build can throw the size cap.
  let env: NodeJS.ProcessEnv | undefined;
  if (step.when) {
    const needsEnv = step.when.kind === "shell" || step.when.kind === "argv";
    const pass = await evalGuard(
      step.when,
      values,
      opts,
      needsEnv ? (env ??= namespaceEnv(values)) : {},
    );
    if (!pass) {
      bindSkippedOuts(step, values);
      opts.onProgress?.(n, total, label, "skip");
      await logStep(opts, n, total, label, undefined, true);
      return { skipped: true };
    }
  }
  env ??= namespaceEnv(values);

  const items = await resolveForItems(step, values, opts, env);
  if (!items.ok) {
    const error = await fail(opts.deps, opts.name, n, items.error);
    opts.onProgress?.(n, total, label, "fail");
    await logStep(opts, n, total, label, error);
    return { failed: { ok: false, error } };
  }

  const loop = step.for !== undefined;
  const itemName = step.as ?? "item";
  const failures: string[] = [];
  const textOuts: string[] = [];

  for (let index = 0; index < items.items.length; index++) {
    if (loop) {
      values.item = items.items[index]!;
      values[itemName] = values.item;
      values.index = String(index);
      env = namespaceEnv(values);
    }
    opts.onProgress?.(n, total, loop ? `${label} [${index}]` : label);
    if (opts.ctx.paneId) {
      void opts.deps
        .reportToken(opts.ctx.paneId, `${opts.name} ${n}/${total}`)
        .catch(() => undefined);
    }

    const beforeOut = step.out?.kind === "text" ? values[step.out.name] : undefined;
    const exec = await runWithRetry(step, opts, values, n, env);
    if (exec.failed) {
      if (step.allowFail) {
        failures.push(exec.failed.error);
        if (loop) continue;
        opts.onProgress?.(n, total, label, "fail");
        await logStep(opts, n, total, label, exec.failed.error);
        return { failures };
      }
      opts.onProgress?.(n, total, label, "fail");
      await logStep(opts, n, total, label, exec.failed.error);
      return { failed: exec.failed };
    }
    if (loop && step.out?.kind === "text") {
      textOuts.push(values[step.out.name] ?? "");
      if (beforeOut !== undefined) values[step.out.name] = beforeOut;
    }
    if (exec.failures) failures.push(...exec.failures);
  }

  if (loop && step.out?.kind === "text") {
    values[step.out.name] = textOuts.join("\n");
  }

  opts.onProgress?.(n, total, label, failures.length ? "fail" : "ok");
  await logStep(opts, n, total, label, failures.length ? failures.join("; ") : undefined);
  return { failures: failures.length ? failures : undefined };
}

async function runSteps(
  steps: FlatStep[],
  opts: StepRunOptions,
  values: PlaceholderValues,
): Promise<StepResult> {
  const total = countSteps(steps);
  let n = 0;
  const tolerated: string[] = [];

  for (const step of steps) {
    n++;
    const exec = await runOneStep(step, opts, values, n, total);
    if (exec.skipped) continue;
    if (exec.failures) tolerated.push(...exec.failures);
    if (exec.failed) {
      if (step.onError) {
        values.error = exec.failed.error;
        const recovery = await runSteps(
          step.onError.steps,
          { ...opts, name: step.onError.name },
          values,
        );
        if (!recovery.ok) {
          return {
            ok: false,
            error: `${exec.failed.error} (on_error also failed: ${recovery.error})`,
            aborted: true,
          };
        }
        // Step recovery already ran — do not chain workflow on_error.
        return {
          ok: false,
          error: exec.failed.error,
          failures: tolerated.length ? tolerated : undefined,
        };
      }
      return {
        ok: false,
        error: exec.failed.error,
        aborted: true,
        failures: tolerated.length ? tolerated : undefined,
        ...(exec.envOverflow ? { envOverflow: true } : {}),
      };
    }
  }
  if (tolerated.length) return { ok: false, error: tolerated.join("; "), failures: tolerated };
  return { ok: true };
}

bindIncludeRunSteps(runSteps as Parameters<typeof bindIncludeRunSteps>[0]);

function countSteps(steps: FlatStep[]): number {
  let n = 0;
  for (const s of steps) {
    n++;
    if (s.action.kind === "include") n += countSteps(s.action.steps) - 1;
  }
  return steps.length;
}

export type RunOptions = {
  name: string;
  repoRoot: string;
  agents: AgentsConfig;
  sessions?: SessionsConfig;
  ctx: InvocationContext;
  prompt?: string;
  inputs?: Record<string, string>;
  workflow?: LoadedWorkflow;
  deps?: Partial<RunnerDeps>;
  onProgress?: (
    step: number,
    total: number,
    label: string,
    outcome?: "ok" | "skip" | "fail",
  ) => void;
  onStderr?: (text: string) => void;
};

export type RunResult = StepResult;

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const runId = randomUUID().slice(0, 8);
  const workflow =
    opts.workflow ?? (await loadWorkflow(opts.name, opts.repoRoot, Object.keys(opts.agents)));
  const stepOpts = {
    name: workflow.name,
    agents: opts.agents,
    ctx: opts.ctx,
    deps,
    runId,
    onProgress: opts.onProgress,
    onStderr: opts.onStderr,
  };

  const failPrecondition = async (detail: string): Promise<RunResult> => {
    const error = await fail(deps, workflow.name, 0, detail);
    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: false,
      error,
    });
    return { ok: false, error };
  };

  let sessionFile = "";
  try {
    const inputs = resolveInputValues(workflow.inputs, opts.inputs);
    if (!inputs.ok) return await failPrecondition(inputs.error);

    const pre = await resolvePreflight(workflow, opts.ctx, opts.agents, opts.sessions ?? {}, deps);
    if (!pre.ok) return await failPrecondition(pre.error);

    if (pre.session) {
      sessionFile = join(tmpdir(), `hwf-session-${runId}.txt`);
      await Bun.write(sessionFile, pre.session);
    }

    const base = await buildPlaceholders({
      ctx: opts.ctx,
      prompt: opts.prompt,
      error: "",
      session: pre.session,
      sessionFile,
      agent: pre.agent,
      inputs: inputs.values,
    });

    // Session extraction failure is a hard abort before steps — does not trigger on_error.
    if (pre.sessionFailure) {
      return await failPrecondition(pre.sessionFailure);
    }

    const primary = await runSteps(workflow.steps, stepOpts, base);
    let result = primary;
    // envOverflow recovery is meaningless: the oversized binding sits in base, so every
    // recovery step would re-throw the same cap error and mis-attribute it to recovery step 1.
    if (!primary.ok && primary.aborted && !primary.envOverflow && workflow.recovery) {
      const recoveryValues = { ...base, error: primary.error };
      const recovery = await runSteps(
        workflow.recovery.steps,
        { ...stepOpts, name: workflow.recovery.name },
        recoveryValues,
      );
      result = {
        ok: false,
        error: recovery.ok
          ? primary.error
          : `${primary.error} (on_error also failed: ${recovery.error})`,
      };
    }

    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    });
    return result;
  } finally {
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
