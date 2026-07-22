import {
  agentLabel,
  agentStatus,
  herdrCall,
  layoutApply,
  notificationShow,
  paneRead,
  reportToken,
  tabClose,
  waitOutput,
} from "../adapter/client";
import { substitute, type FlatStep, type PlaceholderValues } from "../workflows";
import { appendRunLog } from "../runlog";
import { sessionText } from "../session";
import { fail, fire } from "./fire";
import { runShellStep } from "./shell";
import type { RunnerDeps, StepResult, StepRunOptions } from "./types";

export type { RunnerDeps, StepResult, StepRunOptions };

export function defaultDeps(): RunnerDeps {
  return {
    layoutApply,
    herdrCall,
    notificationShow,
    runShell: runShellStep,
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
  if (step.verb === "shell") return `shell: ${step.command}`;
  if (step.verb === "open") return `open: ${step.command}`;
  if (step.verb === "agent") return `agent: ${step.name}`;
  return `herdr: ${step.method}`;
}

function pushTab(values: PlaceholderValues, tabId: string): PlaceholderValues {
  return { ...values, prev_tab: values.tab, tab: tabId };
}

function inputEnv(inputs: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(inputs)) {
    env[`HWF_INPUT_${name}`] = value;
  }
  return env;
}

export async function runSteps(
  steps: FlatStep[],
  opts: StepRunOptions,
  values: PlaceholderValues,
): Promise<StepResult> {
  let last = values.last;
  let tab = values.tab;
  let prev_tab = values.prev_tab;
  const total = steps.length;
  const paneId = opts.ctx.paneId;
  const logStep = (step: number, label: string, error?: string) =>
    appendRunLog({
      ts: new Date().toISOString(),
      run: opts.runId,
      workflow: opts.name,
      step,
      total,
      label,
      ok: error === undefined,
      ...(error === undefined ? {} : { error }),
    });
  for (const [idx, step] of steps.entries()) {
    const i = idx + 1;
    const label = stepLabel(step);
    opts.onProgress?.(i, total, label);
    if (paneId) {
      void opts.deps.reportToken(paneId, `${opts.name} ${i}/${total}`).catch(() => undefined);
    }
    const current = { ...values, last, tab, prev_tab };
    if (step.verb === "shell") {
      const stdin = step.stdin !== undefined ? substitute(step.stdin, current) : undefined;
      const result = await opts.deps.runShell(step.command, {
        cwd: opts.ctx.cwd,
        stdin,
        env: inputEnv(current.inputs),
      });
      if (result.stderr) opts.onStderr?.(result.stderr);
      if (!result.ok) {
        const error = await fail(opts.deps, opts.name, i, result.stderr.trim() || "nonzero exit");
        await logStep(i, label, error);
        return { ok: false, error, last };
      }
      last = result.stdout;
      await logStep(i, label);
      continue;
    }
    const outcome = await fire(opts, step, current, i, last);
    if (outcome?.failed) {
      const failed = outcome.failed;
      await logStep(i, label, failed.ok ? undefined : failed.error);
      return failed;
    }
    if (outcome?.last !== undefined) last = outcome.last;
    if (outcome?.tabId !== undefined) {
      const next = pushTab({ ...current, last }, outcome.tabId);
      tab = next.tab;
      prev_tab = next.prev_tab;
    }
    await logStep(i, label);
  }
  return { ok: true, last };
}
