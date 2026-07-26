import {
  agentLabel,
  agentStatus,
  layoutApply,
  notificationShow,
  paneRead,
  reportToken,
  tabClose,
  waitOutput,
} from "../adapter/client";
import { herdrCall } from "../adapter/rpc";
import { appendRunLog } from "../runlog";
import { sessionText } from "../session";
import type { FlatStep, PlaceholderValues } from "../workflow/types";
import { substitute } from "../workflow/parse";
import { fail, fire } from "./fire";
import { bindSkippedOuts, evalGuard, resolveForItems } from "./guards";
import { runArgvStep, runShellStep } from "./shell";
import type { RunnerDeps, StepResult, StepRunOptions } from "./types";

export function defaultDeps(): RunnerDeps {
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
    reportToken,
    sessionText,
    tabClose,
  };
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

function namespaceEnv(values: PlaceholderValues): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) env[`HWF_${name}`] = value;
  }
  return env;
}

type FailedStep = { ok: false; error: string };

type StepExec = {
  skipped?: boolean;
  failed?: FailedStep;
  failures?: string[];
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
  if (step.action.kind === "include") {
    const childValues: PlaceholderValues = {
      pane: values.pane ?? "",
      selection: values.selection ?? "",
      prompt: values.prompt ?? "",
      session: values.session ?? "",
      session_file: values.session_file ?? "",
      source_tab: values.source_tab ?? "",
      agent: values.agent ?? "",
      error: values.error ?? "",
    };
    for (const [k, v] of Object.entries(step.action.defaults)) {
      childValues[k] = substitute(v, values);
    }
    for (const [k, v] of Object.entries(step.action.with)) {
      childValues[k] = substitute(v, values);
    }
    const result = await runSteps(step.action.steps, opts, childValues);
    if (!result.ok) return { failed: result, failures: result.failures };
    for (const name of step.action.exportedOuts) {
      if (childValues[name] !== undefined) values[name] = childValues[name]!;
    }
    return { failures: result.failures };
  }

  const outcome = await fire(opts, step, values, n, env);
  if (outcome.failed) return { failed: outcome.failed };
  if (outcome.bindings) {
    for (const [k, v] of Object.entries(outcome.bindings)) values[k] = v;
  }
  return {};
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
  env: NodeJS.ProcessEnv,
): Promise<StepExec> {
  const label = stepLabel(step);
  if (step.when) {
    const pass = await evalGuard(step.when, values, opts, env);
    if (!pass) {
      bindSkippedOuts(step, values);
      opts.onProgress?.(n, total, label, "skip");
      await logStep(opts, n, total, label, undefined, true);
      return { skipped: true };
    }
  }

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
      values[itemName] = items.items[index]!;
      values.index = String(index);
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

export async function runSteps(
  steps: FlatStep[],
  opts: StepRunOptions,
  values: PlaceholderValues,
): Promise<StepResult> {
  const total = countSteps(steps);
  let n = 0;
  const env = namespaceEnv(values);
  const tolerated: string[] = [];

  for (const step of steps) {
    n++;
    const exec = await runOneStep(step, opts, values, n, total, env);
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
          return { ok: false, error: recovery.error, aborted: true };
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
      };
    }
  }
  if (tolerated.length) return { ok: false, error: tolerated.join("; "), failures: tolerated };
  return { ok: true };
}

function countSteps(steps: FlatStep[]): number {
  let n = 0;
  for (const s of steps) {
    n++;
    if (s.action.kind === "include") n += countSteps(s.action.steps) - 1;
  }
  return steps.length;
}
