import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentStatus,
  herdrCall,
  notificationShow,
  paneClose,
  reportToken,
  tabClose,
} from "../herdr";
import {
  buildTemplateNamespace,
  pluginStateDir,
  type InvocationContext,
  type WorkflowsConfig,
} from "../config";
import { assertUnderHwfEnvCap } from "../limits";
import { appendRunLog } from "../runlog";
import { transcriptText } from "../session";
import { workflowTemplateRefs } from "../workflow/parse";
import type { InputSpec, LoadedWorkflow, TemplateNamespace, WorkflowStep } from "../workflow/types";
import { loadWorkflow } from "../workflow/load";
import {
  errorText,
  type RunnerDeps,
  type StepCtx,
  type StepOutcome,
  type StepRunOpts,
  type StepsResult,
} from "./context";
import { agentStep } from "./steps/agent";
import { bindIncludeRunSteps, workflowStep } from "./steps/include";
import { herdrStep } from "./steps/primitive";
import { shellStep } from "./steps/shell";

type StepRunner = (c: StepCtx) => Promise<StepOutcome>;

const RUNNERS: Record<WorkflowStep["action"]["kind"], StepRunner> = {
  run: (c) => shellStep({ ...c, env: process.env }),
  agent: agentStep,
  herdr: herdrStep,
  workflow: workflowStep,
};

async function agentInfo(target: string): Promise<Record<string, unknown>> {
  const result = await herdrCall("agent.get", { target });
  const agent = result.agent;
  return agent && typeof agent === "object" ? (agent as Record<string, unknown>) : {};
}

function defaultDeps(): RunnerDeps {
  return {
    herdrCall,
    notificationShow,
    agentStatus,
    agentInfo,
    paneClose,
    tabClose,
    reportToken,
    transcriptText,
    sleep: (ms: number) => Bun.sleep(ms),
    now: () => Date.now(),
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

function bindResult(step: WorkflowStep, values: TemplateNamespace, outcome: StepOutcome): void {
  if (!step.id || !outcome.ok || outcome.result === undefined) return;
  values.steps[step.id] = outcome.result;
}

async function runSteps(
  steps: WorkflowStep[],
  opts: StepRunOpts,
  values: TemplateNamespace,
): Promise<StepsResult> {
  const total = steps.length;
  let n = 0;
  for (const step of steps) {
    n++;
    const label = stepLabel(step);
    opts.onProgress?.(n, total, label);
    const outcome = await RUNNERS[step.action.kind]({ step, stepIndex: n, values, opts });
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
      return {
        ok: false,
        error,
        aborted: true,
        ...(outcome.coordinationLost ? { coordinationLost: true } : {}),
      };
    }
    bindResult(step, values, outcome);
    await appendRunLog({
      ts: new Date().toISOString(),
      run: opts.runId,
      workflow: opts.name,
      step: n,
      total,
      label,
      ok: true,
      ...(outcome.skipped ? { skipped: true } : {}),
    });
  }
  return { ok: true };
}

bindIncludeRunSteps(runSteps);

const IDENTITY_KEYS = ["workspace", "tab", "pane", "worktree"] as const;
const TRANSCRIPT_KEYS = ["transcript", "transcript_file"];

function referencedContextKeys(workflow: LoadedWorkflow): Set<string> {
  const keys = new Set<string>();
  for (const ref of workflowTemplateRefs(workflow.steps, workflow.returns, workflow.onFailure)) {
    if (ref.root === "context" && ref.segments[0] !== undefined) keys.add(ref.segments[0]);
  }
  return keys;
}

function identityValue(ctx: InvocationContext, key: (typeof IDENTITY_KEYS)[number]): string {
  if (key === "workspace") return ctx.workspaceId ?? "";
  if (key === "tab") return ctx.tabId ?? "";
  if (key === "pane") return ctx.paneId ?? "";
  return ctx.worktreePath ?? "";
}

type PreflightArgs = {
  workflow: LoadedWorkflow;
  ctx: InvocationContext;
  config: WorkflowsConfig;
  deps: RunnerDeps;
  runId: string;
  inputs: Record<string, string>;
};

type Preflight =
  | { ok: true; values: TemplateNamespace; transcriptFile?: string }
  | { ok: false; error: string };

async function invokingAgentName(args: PreflightArgs): Promise<string> {
  const paneId = args.ctx.paneId;
  if (!paneId) throw new Error("context.agent needs an invoking herdr pane");
  const info = await args.deps.agentInfo(paneId);
  const name = typeof info.name === "string" ? info.name : "";
  if (!name) throw new Error(`context.agent is unavailable: no named agent in pane ${paneId}`);
  return name;
}

async function writeTranscriptFile(runId: string, text: string): Promise<string> {
  const path = join(pluginStateDir(), "transcripts", `${runId}.txt`);
  await mkdir(join(pluginStateDir(), "transcripts"), { recursive: true });
  await Bun.write(path, text);
  return path;
}

async function preflightContext(args: PreflightArgs): Promise<Preflight> {
  const keys = referencedContextKeys(args.workflow);
  for (const key of IDENTITY_KEYS) {
    if (keys.has(key) && !identityValue(args.ctx, key)) {
      return { ok: false, error: `context.${key} is not available in this invocation` };
    }
  }
  let agent: string | undefined;
  let transcript: string | undefined;
  let transcriptFile: string | undefined;
  try {
    if (keys.has("agent")) agent = await invokingAgentName(args);
    if (TRANSCRIPT_KEYS.some((key) => keys.has(key))) {
      const paneId = args.ctx.paneId;
      if (!paneId) return { ok: false, error: "context.transcript needs an invoking herdr pane" };
      transcript = await args.deps.transcriptText(paneId, args.config.transcripts, {
        invocationCwd: args.ctx.cwd,
      });
      if (keys.has("transcript_file")) {
        transcriptFile = await writeTranscriptFile(args.runId, transcript);
      }
    }
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  return {
    ok: true,
    values: buildTemplateNamespace({
      ctx: args.ctx,
      inputs: args.inputs,
      ...(agent !== undefined ? { agent } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      ...(transcriptFile !== undefined ? { transcriptFile } : {}),
    }),
    ...(transcriptFile !== undefined ? { transcriptFile } : {}),
  };
}

export type RunOptions = {
  name: string;
  repoRoot: string;
  config: WorkflowsConfig;
  ctx: InvocationContext;
  prompt?: string;
  inputs?: Record<string, string>;
  workflow?: LoadedWorkflow;
  deps?: Partial<RunnerDeps>;
  onProgress?: (step: number, total: number, label: string, outcome?: string) => void;
  onStderr?: (text: string) => void;
};

export type RunResult = StepsResult;

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const runId = randomUUID().slice(0, 8);
  const workflow = opts.workflow ?? (await loadWorkflow(opts.name, opts.repoRoot, opts.config));
  const stepOpts: StepRunOpts = {
    name: workflow.name,
    repoRoot: opts.repoRoot,
    config: opts.config,
    ctx: opts.ctx,
    deps,
    runId,
    workflowPath: [workflow.name],
    isEntry: true,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
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

  let transcriptFile: string | undefined;
  try {
    const inputs = resolveInputValues(workflow.inputs, opts.inputs);
    if (!inputs.ok) return await failPrecondition(inputs.error);

    const hwfBlock = Object.entries(inputs.values)
      .map(([name, value]) => `HWF_${name}=${value}`)
      .join("\n");
    try {
      assertUnderHwfEnvCap("HWF environment", hwfBlock);
    } catch (error) {
      return await failPrecondition(errorText(error));
    }

    const context = await preflightContext({
      workflow,
      ctx: opts.ctx,
      config: opts.config,
      deps,
      runId,
      inputs: inputs.values,
    });
    if (!context.ok) return await failPrecondition(context.error);
    transcriptFile = context.transcriptFile;

    const primary = await runSteps(workflow.steps, stepOpts, context.values);
    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: primary.ok,
      ...(primary.ok ? {} : { error: primary.error }),
    });
    return primary;
  } finally {
    if (transcriptFile) await rm(transcriptFile, { force: true }).catch(() => undefined);
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
