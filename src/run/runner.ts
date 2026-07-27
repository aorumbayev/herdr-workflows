import { randomUUID } from "node:crypto";
import {
  agentLabel,
  agentStatus,
  herdrCall,
  layoutApply,
  notificationShow,
  paneClose,
  paneRead,
  placeCommand,
  reportToken,
  tabClose,
  waitOutput,
} from "../herdr";
import { buildTemplateNamespace, type InvocationContext, type WorkflowsConfig } from "../config";
import { assertUnderHwfEnvCap } from "../limits";
import { appendRunLog } from "../runlog";
import { transcriptText } from "../session";
import type { InputSpec, LoadedWorkflow, TemplateNamespace, WorkflowStep } from "../workflow/types";
import { loadWorkflow } from "../workflow/load";
import { agentStep } from "./steps/agent";
import { bindIncludeRunSteps, workflowStep } from "./steps/include";
import { herdrStep } from "./steps/primitive";
import { runArgvStep, runShellStep, shellStep } from "./steps/shell";

type RunnerDeps = {
  layoutApply: typeof layoutApply;
  herdrCall: typeof herdrCall;
  notificationShow: typeof notificationShow;
  runShell: typeof runShellStep;
  runArgv: typeof runArgvStep;
  placeCommand: typeof placeCommand;
  agentStatus: typeof agentStatus;
  agentLabel: typeof agentLabel;
  waitOutput: typeof waitOutput;
  paneRead: typeof paneRead;
  paneClose: typeof paneClose;
  reportToken: typeof reportToken;
  transcriptText: typeof transcriptText;
  tabClose: typeof tabClose;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  agentWaitPollMs?: number;
  agentWaitIdleGraceMs?: number;
};

type StepResult =
  | { ok: true; skipped?: boolean; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      aborted?: boolean;
      envOverflow?: boolean;
    };

type StepRunOptions = {
  name: string;
  config: WorkflowsConfig;
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

type StepContext = {
  step: WorkflowStep;
  values: TemplateNamespace;
  opts: StepRunOptions;
};

type StepOutcome = { ok: true } | { ok: false; error: string };

type StepRunner = (c: StepContext) => Promise<StepOutcome>;

const RUNNERS: Record<WorkflowStep["action"]["kind"], StepRunner> = {
  run: ((c) =>
    shellStep({
      ...c,
      env: process.env,
      opts: {
        ctx: c.opts.ctx,
        deps: c.opts.deps,
        onStderr: c.opts.onStderr,
      },
    })) as StepRunner,
  agent: agentStep as StepRunner,
  herdr: herdrStep as StepRunner,
  workflow: workflowStep as StepRunner,
};

function defaultDeps(): RunnerDeps {
  return {
    layoutApply,
    herdrCall,
    notificationShow,
    runShell: runShellStep,
    runArgv: runArgvStep,
    placeCommand,
    agentStatus,
    agentLabel,
    waitOutput,
    paneRead,
    paneClose,
    reportToken,
    transcriptText,
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

type ResolvedInputs = { ok: true; values: Record<string, string> } | { ok: false; error: string };

function resolveInputValues(
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

function stepLabel(step: WorkflowStep): string {
  if (step.id) return step.id;
  const a = step.action;
  if (a.kind === "run") {
    if (a.payload.form === "argv") return `run: ${a.payload.argv.join(" ")}`;
    return `run: ${a.payload.command.split("\n")[0]}`;
  }
  if (a.kind === "agent") return "agent";
  if (a.kind === "herdr") return a.method;
  return `workflow: ${a.name}`;
}

async function runSteps(
  steps: WorkflowStep[],
  opts: StepRunOptions,
  values: TemplateNamespace,
): Promise<StepResult> {
  const total = steps.length;
  let n = 0;
  for (const step of steps) {
    n++;
    const label = stepLabel(step);
    opts.onProgress?.(n, total, label);
    const outcome = await RUNNERS[step.action.kind]({ step, values, opts });
    if (!outcome.ok) {
      const error = await fail(opts.deps, opts.name, n, outcome.error);
      await appendRunLog({
        ts: new Date().toISOString(),
        run: opts.runId,
        workflow: opts.name,
        step: n,
        total,
        label,
        ok: false,
        error,
      });
      return { ok: false, error, aborted: true };
    }
    await appendRunLog({
      ts: new Date().toISOString(),
      run: opts.runId,
      workflow: opts.name,
      step: n,
      total,
      label,
      ok: true,
    });
  }
  return { ok: true };
}

bindIncludeRunSteps(runSteps);

export type RunOptions = {
  name: string;
  repoRoot: string;
  config: WorkflowsConfig;
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
  const workflow = opts.workflow ?? (await loadWorkflow(opts.name, opts.repoRoot, opts.config));
  const stepOpts = {
    name: workflow.name,
    config: opts.config,
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

  try {
    const inputs = resolveInputValues(workflow.inputs, opts.inputs);
    if (!inputs.ok) return await failPrecondition(inputs.error);

    const hwfBlock = Object.entries(inputs.values)
      .map(([name, value]) => `HWF_${name}=${value}`)
      .join("\n");
    try {
      assertUnderHwfEnvCap("HWF environment", hwfBlock);
    } catch (error) {
      return await failPrecondition(error instanceof Error ? error.message : String(error));
    }

    const values = await buildTemplateNamespace({
      ctx: opts.ctx,
      inputs: inputs.values,
    });

    const primary = await runSteps(workflow.steps, stepOpts, values);
    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: primary.ok,
      ...(primary.ok ? {} : { error: primary.error }),
    });
    return primary;
  } finally {
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
