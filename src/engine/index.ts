import { closeSync, mkdirSync, openSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { z } from "zod";
import { assertHwfEnvValues } from "../caps";
import { pluginStateDir, type InvocationContext, type WorkflowsConfig } from "../context";
import { transcriptText } from "../transcript";
import {
  buildTemplateNamespace,
  completeWorkflowInputs,
  evaluateWhen,
  loadWorkflow,
  workflowTemplateRefs,
} from "../workflow/inputs";
import {
  createRunRecorder,
  parseProgressLine,
  type ProgressOutcome,
  type RunRecorder,
  type RunStepOutcomeKind,
} from "../history";
import {
  agentStatus,
  herdrCall,
  notificationShow,
  paneClose,
  reportToken,
  tabClose,
} from "../host";
import { substituteText, substituteValue } from "../workflow/grammar";
import type {
  TemplateNamespace,
  WorkflowStep,
  StepAction,
  LoadedWorkflow,
  ReturnsSpec,
  RecoveryAction,
} from "../workflow/grammar";
import {
  ensureRunScratchDir,
  errorText,
  type RunnerDeps,
  type StepFailure,
  type StepFrame,
  type StepOutcome,
  type StepRunOpts,
  type StepsResult,
} from "./contract";
import { herdrStep, shellStep } from "./command";
import { agentStep } from "./agent-turn";

export { CoordinationError, isCoordinationError } from "./contract";
export type { RunnerDeps, StepsResult } from "./contract";
export { placeCommandPane, quoteArgvForShell, sizeToFirstRatio } from "./pane";
export {
  buildHwfEnv,
  killSpawn,
  mergeStepEnv,
  runArgvStep,
  runShellStep,
  shellArgv,
  spawnCapture,
} from "./command";
export { generateAgentName, readManagedResponse } from "./agent-turn";

type WorkflowActionSpec = Extract<StepAction, { kind: "workflow" }>;

type ResolvedInputs = { ok: true; values: Record<string, string> } | { ok: false; error: string };

function evaluateReturns(returns: ReturnsSpec, ns: TemplateNamespace): unknown {
  if (returns.kind === "template") return substituteValue(returns.template, ns);
  return Object.fromEntries(
    Object.entries(returns.fields).map(([name, template]) => [name, substituteValue(template, ns)]),
  );
}

async function workflowStep(frame: StepFrame): Promise<StepOutcome> {
  const action = frame.step.action;
  if (action.kind !== "workflow") return { ok: false, error: "internal: not a workflow step" };
  return runChild(frame, action);
}

async function runChild(frame: StepFrame, action: WorkflowActionSpec): Promise<StepOutcome> {
  const child = frame.opts.children.get(action.name);
  if (!child) {
    return {
      ok: false,
      error: `workflow '${action.name}' missing from loaded child graph`,
      details: { workflow: action.name },
    };
  }
  const repoRoot = frame.opts.repoRoot;
  const passed = Object.fromEntries(
    Object.entries(action.inputs ?? {}).map(([name, template]) => [
      name,
      substituteText(template, frame.values),
    ]),
  );
  let inputs: ResolvedInputs;
  try {
    const collected = await completeWorkflowInputs(child, {
      provided: passed,
      config: frame.opts.config,
      repoRoot,
      resolveDynamic: true,
    });
    inputs = collected.ok
      ? { ok: true, values: collected.values }
      : { ok: false, error: collected.error };
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }
  if (!inputs.ok) return { ok: false, error: inputs.error, details: { workflow: action.name } };

  try {
    assertHwfEnvValues("HWF environment", inputs.values);
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }

  const childValues: TemplateNamespace = {
    inputs: inputs.values,
    steps: {},
    context: frame.values.context,
  };
  const childPath = [...frame.opts.workflowPath, child.name];
  const result = await frame.opts.runSteps(
    child.steps,
    {
      ...frame.opts,
      name: child.name,
      workflowPath: childPath,
      children: child.children,
      recorder: frame.opts.recorder.child({
        name: child.name,
        workflowPath: childPath,
        parentOrdinal: frame.stepIndex,
      }),
    },
    childValues,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      details: { workflow: child.name },
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.coordinationLost ? { coordinationLost: true } : {}),
    };
  }
  if (!child.returns) return { ok: true };
  return { ok: true, result: evaluateReturns(child.returns, childValues) };
}

type DetachedRunResult = { ok: boolean; detail: string };

export type DetachedRunHandle = {
  result: Promise<DetachedRunResult>;
  detach: () => void;
};

const launchPayloadSchema = z.object({
  name: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  domains: z.record(z.string(), z.array(z.string())).optional(),
  runId: z.string().min(1).optional(),
});

/** Secrets for a detached `hwf run` — sent on stdin, never on argv. */
export type LaunchPayload = z.infer<typeof launchPayloadSchema>;

export type LaunchRunRequest = {
  name: string;
  repoRoot: string;
  ctx: InvocationContext;
  inputs: Record<string, string>;
  domains?: Record<string, string[]>;
  runId?: string;
  onProgressLine: (line: string) => void;
  onHistoryAck?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof Bun.spawn;
};

const SELF_EXEC = process.execPath;
const SELF_ENTRY = process.argv[1];

/** Env the detached `hwf run` child must inherit so context.* stays the caller's. */
function buildInvocationEnv(ctx: InvocationContext, repoRoot: string): Record<string, string> {
  const json: Record<string, unknown> = {
    selected_text: ctx.selection,
    cwd: ctx.cwd,
  };
  if (ctx.paneId) json.focused_pane_id = ctx.paneId;
  if (ctx.tabId) json.tab_id = ctx.tabId;
  if (ctx.workspaceId) json.workspace_id = ctx.workspaceId;
  if (ctx.worktreePath) json.worktree = { path: ctx.worktreePath };

  const env: Record<string, string> = {
    HERDR_WORKFLOWS_REPO_ROOT: repoRoot,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(json),
  };
  if (ctx.paneId) env.HERDR_PANE_ID = ctx.paneId;
  if (ctx.tabId) env.HERDR_TAB_ID = ctx.tabId;
  if (ctx.workspaceId) env.HERDR_WORKSPACE_ID = ctx.workspaceId;
  return env;
}

/** True when argv[1] is a real on-disk script the runtime must re-pass (dev `bun src/cli.ts`). */
function isRuntimeScriptEntry(entry: string | undefined): boolean {
  if (typeof entry !== "string" || entry.length === 0) return false;
  // Compiled bun binaries expose an embedded virtual path — not a host file to re-exec.
  if (entry.startsWith("/$bunfs/")) return false;
  try {
    return statSync(entry).isFile();
  } catch {
    return false;
  }
}

/** Source files a workbench serves, so a dev edit to one of them makes the running server stale. */
const SERVED_SOURCE_RE = /\.(ts|html)$/;

export type CodeWatchPath = { path: string; recursive: boolean };

/**
 * Identity of the build this process runs, recorded on an owned workbench's endpoint so an
 * adopting client can refuse a workbench built from other code. A script entry has no stable
 * identity — `execPath` is then the runtime, unchanged by edits — so dev relies on the watch
 * instead.
 */
export function buildIdentity(
  entry: string | undefined = Bun.main,
  execPath: string = process.execPath,
): string | undefined {
  if (entry !== undefined && isRuntimeScriptEntry(entry)) return undefined;
  try {
    const stat = statSync(execPath);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/**
 * What an owned workbench watches to learn its own code changed, or undefined when there is
 * nothing worth watching. Only a script entry watches: its sources change in place, under a
 * directory that stays put. A compiled install is covered by build identity at adoption instead —
 * an upgrade renames the whole managed checkout, and a filesystem watch cannot see a rename of an
 * ancestor on Linux, where watches are bound to inodes rather than paths.
 */
function codeWatchPath(entry: string | undefined = Bun.main): CodeWatchPath | undefined {
  if (entry !== undefined && isRuntimeScriptEntry(entry)) {
    return { path: dirname(entry), recursive: true };
  }
  return undefined;
}

/**
 * A workbench must not outlive the code it was built from: a stale server keeps answering
 * authenticated probes, so picker actions adopt it and serve the previous build. Returns a
 * disposer; an unwatchable path is not fatal, since termination signals still stop the process.
 */
export function retireOnCodeChange(
  onRetire: () => void,
  path: CodeWatchPath | undefined = codeWatchPath(),
): () => void {
  if (!path) return () => undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(path.path, { recursive: path.recursive }, (_event, file) => {
      if (path.recursive && !SERVED_SOURCE_RE.test(String(file ?? ""))) return;
      onRetire();
    });
  } catch {
    return () => undefined;
  }
  watcher.unref();
  return () => watcher.close();
}

function selfArgv(command: string, commandArgs: string[]): string[] {
  if (SELF_ENTRY !== undefined && isRuntimeScriptEntry(SELF_ENTRY)) {
    return [SELF_EXEC, SELF_ENTRY, command, ...commandArgs];
  }
  return [SELF_EXEC, command, ...commandArgs];
}

function buildLaunchPayload(
  name: string,
  inputs: Record<string, string>,
  domains?: Record<string, string[]>,
  runId?: string,
): LaunchPayload {
  return {
    name,
    inputs,
    ...(domains !== undefined && Object.keys(domains).length > 0 ? { domains } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}

function launchPayloadError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "launch payload is invalid";
  const path = issue.path.map(String);
  if (path.length === 0) return "launch payload must be a JSON object";
  if (path[0] === "name") return "launch payload requires a string name";
  if (path[0] === "inputs" && path.length === 1) return "launch payload inputs must be an object";
  if (path[0] === "inputs") return `launch payload inputs.${path[1]} must be a string`;
  if (path[0] === "domains" && path.length === 1) return "launch payload domains must be an object";
  if (path[0] === "domains") return `launch payload domains.${path[1]} must be a string array`;
  if (path[0] === "runId") return "launch payload runId must be a non-empty string";
  return issue.message || "launch payload is invalid";
}

export function parseLaunchPayload(text: string): LaunchPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("launch payload is not valid JSON");
  }
  const result = launchPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error(launchPayloadError(result.error));
  return result.data;
}

/** Incomplete-line diagnostic tail — progress/history lines still require a newline. */
const DECODE_LINE_TAIL = 64 * 1024;

/** Stream lines without retaining the aggregate body. */
async function decodeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (buf.length > DECODE_LINE_TAIL) buf = buf.slice(-DECODE_LINE_TAIL);
  }
  buf += decoder.decode();
  if (buf.length > DECODE_LINE_TAIL) buf = buf.slice(-DECODE_LINE_TAIL);
  if (buf) onLine(buf);
}

/** Spawn `hwf run` in its own process group so the picker popup can exit freely. */
export function launchDetachedRun(req: LaunchRunRequest): DetachedRunHandle {
  const spawn = req.spawn ?? Bun.spawn.bind(Bun);
  const argv = selfArgv("run", [req.name, "--launch-payload"]);
  const payload = JSON.stringify(buildLaunchPayload(req.name, req.inputs, req.domains, req.runId));
  const env = {
    ...process.env,
    ...req.env,
    ...buildInvocationEnv(req.ctx, req.repoRoot),
  };
  const proc = spawn(argv, {
    cwd: req.repoRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  // Feed secrets once and close — never block the picker on the child's stdin.
  proc.stdin.write(payload);
  proc.stdin.end();

  let detached = false;
  let settle: ((value: DetachedRunResult) => void) | undefined;
  const result = new Promise<DetachedRunResult>((resolve) => {
    settle = resolve;
  });

  const detach = () => {
    if (detached) return;
    detached = true;
    settle?.({ ok: true, detail: "detached" });
    settle = undefined;
    proc.unref();
  };

  void (async () => {
    let lastProgress = "";
    let lastStdoutDiag = "";
    let lastStderrDiag = "";
    const onStdoutLine = (line: string) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      if (trimmed.startsWith("@hwf-history:")) {
        if (!detached) req.onHistoryAck?.(trimmed);
        return;
      }
      if (parseProgressLine(trimmed)) {
        lastProgress = trimmed;
        if (!detached) req.onProgressLine(trimmed);
        return;
      }
      lastStdoutDiag = trimmed;
    };
    const onStderrLine = (line: string) => {
      const trimmed = line.trimEnd();
      if (trimmed) lastStderrDiag = trimmed;
    };
    const [, , code] = await Promise.all([
      decodeLines(proc.stdout, onStdoutLine),
      decodeLines(proc.stderr, onStderrLine),
      proc.exited,
    ]);
    if (detached) return;
    if (code === 0) {
      settle?.({ ok: true, detail: "" });
      settle = undefined;
      return;
    }
    const detail = lastStderrDiag || lastStdoutDiag || lastProgress || `run exited ${code}`;
    settle?.({ ok: false, detail });
    settle = undefined;
  })();

  return { result, detach };
}

export type LaunchWebRequest = {
  route: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof Bun.spawn;
};

/** Env the detached `hwf web` child needs for the same repo workbench. */
function buildWebLaunchEnv(
  repoRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    HERDR_WORKFLOWS_REPO_ROOT: repoRoot,
  };
}

/** Append-only log for detached `hwf web` stderr (picker dismisses before the child settles). */
function webLaunchStderrPath(stateDir: string = pluginStateDir()): string {
  return join(stateDir, "web-launch.stderr.log");
}

/**
 * Fire-and-forget `hwf web <route>`. No stdout parsing, no retained handle —
 * the web command owns endpoint reuse and browser open.
 * Stdout stays ignored: the picker dismisses and Herdr tears down the popup PTY;
 * inheriting it raises EPIPE in `hwf web` before it can open the browser.
 * Stderr prefers an append log under plugin state; if that path is unusable,
 * fall back to ignore so diagnostics never block the handoff.
 */
export function launchDetachedWeb(req: LaunchWebRequest): void {
  const spawn = req.spawn ?? Bun.spawn.bind(Bun);
  const argv = selfArgv("web", [req.route]);
  const env = buildWebLaunchEnv(req.repoRoot, { ...process.env, ...req.env });
  const stderr = openWebLaunchStderr(pluginStateDir(env));
  try {
    const proc = spawn(argv, {
      cwd: req.repoRoot,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr,
      detached: true,
    });
    proc.unref();
  } finally {
    if (typeof stderr === "number") closeSync(stderr);
  }
}

/** Best-effort stderr sink; `"ignore"` when the state log cannot be opened. */
function openWebLaunchStderr(stateDir: string): number | "ignore" {
  try {
    mkdirSync(stateDir, { recursive: true });
    return openSync(webLaunchStderrPath(stateDir), "a");
  } catch {
    return "ignore";
  }
}

type StepRunner = (frame: StepFrame) => Promise<StepOutcome>;

const RUNNERS: Record<WorkflowStep["action"]["kind"], StepRunner> = {
  run: (frame) => shellStep({ ...frame, env: process.env }),
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
  await deps
    .notificationShow(
      `herdr-workflows: ${workflow} failed`,
      `Step ${step} failed; inspect the terminal or run history for details.`,
    )
    .catch(() => undefined);
  return text;
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

/**
 * context: three distinct outcome vocabularies exist by layer and stay separate on purpose —
 * `StepOutcome` is the runtime union the runner branches on, `RunStepOutcomeKind` is the recorded
 * history label, and `ProgressOutcome` is the terse stdout progress suffix. This is the only bridge
 * between them: every conversion derives the recorded kind first, then maps that kind to progress,
 * so no second inline map can drift the three apart.
 */
export function recordedOutcomeKind(outcome: StepOutcome): RunStepOutcomeKind {
  if (!outcome.ok) return outcome.coordinationLost === true ? "interrupted" : "failed";
  return outcome.launched === true ? "launched" : "succeeded";
}

const PROGRESS_BY_OUTCOME_KIND: Record<RunStepOutcomeKind, ProgressOutcome> = {
  succeeded: "ok",
  skipped: "skip",
  launched: "launch",
  failed_continued: "fail",
  failed: "fail",
  interrupted: "fail",
};

function progressOutcomeOf(kind: RunStepOutcomeKind): ProgressOutcome {
  return PROGRESS_BY_OUTCOME_KIND[kind];
}

function bindResult(step: WorkflowStep, values: TemplateNamespace, outcome: StepOutcome): void {
  if (!step.id || !outcome.ok || outcome.result === undefined) return;
  values.steps[step.id] = outcome.result;
}

function retryOf(step: WorkflowStep): { attempts: number; delayMs?: number } | undefined {
  const action = step.action;
  if (action.kind === "run" || action.kind === "herdr") return action.retry;
  return undefined;
}

function failureOf(
  opts: StepRunOpts,
  step: WorkflowStep,
  stepIndex: number,
  outcome: Extract<StepOutcome, { ok: false }>,
): StepFailure {
  if (outcome.failure) return outcome.failure;
  return {
    message: outcome.error,
    workflow: opts.name,
    action: step.action.kind,
    step_number: stepIndex,
    workflow_path: [...opts.workflowPath],
    ...(step.id ? { step_id: step.id } : {}),
    details: {
      ...outcome.details,
      ...(step.action.kind === "herdr"
        ? { method: step.action.method, reason: outcome.error }
        : {}),
      ...(step.action.kind === "workflow" ? { workflow: step.action.name } : {}),
    },
  };
}

async function executeOnce(
  step: WorkflowStep,
  stepIndex: number,
  values: TemplateNamespace,
  opts: StepRunOpts,
): Promise<StepOutcome> {
  return RUNNERS[step.action.kind]({ step, stepIndex, values, opts });
}

async function executeWithRetry(
  step: WorkflowStep,
  stepIndex: number,
  values: TemplateNamespace,
  opts: StepRunOpts,
): Promise<StepOutcome> {
  const retry = retryOf(step);
  const attempts = retry?.attempts ?? 1;
  let last: StepOutcome | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await executeOnce(step, stepIndex, values, opts);
    if (last.ok || last.coordinationLost) return last;
    if (attempt < attempts && retry?.delayMs) await opts.deps.sleep(retry.delayMs);
    if (attempt < attempts) continue;
  }
  return last ?? { ok: false, error: "internal: retry produced no outcome" };
}

async function hardStepFailure(
  opts: StepRunOpts,
  step: WorkflowStep,
  stepIndex: number,
  total: number,
  label: string,
  outcome: Extract<StepOutcome, { ok: false }>,
  tolerated: string[],
  interrupted: boolean,
): Promise<StepsResult> {
  const error = await fail(opts.deps, opts.name, stepIndex, outcome.error);
  await opts.recorder.stepFinished(
    step,
    stepIndex,
    total,
    label,
    interrupted ? "interrupted" : "failed",
    { ...outcome, error },
  );
  return {
    ok: false,
    error,
    aborted: true,
    ...(interrupted ? { coordinationLost: true } : {}),
    failure: failureOf(opts, step, stepIndex, outcome),
    ...(tolerated.length > 0 ? { failures: tolerated } : {}),
  };
}

async function runSteps(
  steps: WorkflowStep[],
  opts: StepRunOpts,
  values: TemplateNamespace,
): Promise<StepsResult> {
  const total = steps.length;
  const tolerated: string[] = [];
  let n = 0;
  for (const step of steps) {
    n++;
    const label = stepLabel(step);
    if (step.when && !evaluateWhen(step.when, values)) {
      opts.onProgress?.(n, total, label, "skip");
      await opts.recorder.stepFinished(step, n, total, label, "skipped");
      continue;
    }
    opts.onProgress?.(n, total, label, "start");
    await opts.recorder.stepStarted(step, n, total, label);
    const outcome = await executeWithRetry(step, n, values, opts);
    const kind = recordedOutcomeKind(outcome);
    if (!outcome.ok) {
      opts.onProgress?.(n, total, label, progressOutcomeOf(kind));
      if (outcome.coordinationLost) {
        return hardStepFailure(opts, step, n, total, label, outcome, tolerated, true);
      }
      if (step.continueOnError && outcome.hardFailure !== true) {
        tolerated.push(outcome.error);
        await opts.recorder.stepFinished(step, n, total, label, "failed_continued", outcome);
        continue;
      }
      return hardStepFailure(opts, step, n, total, label, outcome, tolerated, false);
    }
    bindResult(step, values, outcome);
    opts.onProgress?.(n, total, label, progressOutcomeOf(kind));
    await opts.recorder.stepFinished(step, n, total, label, kind, outcome);
  }
  if (tolerated.length) return { ok: false, error: tolerated.join("; "), failures: tolerated };
  return { ok: true };
}

async function runRecovery(
  action: RecoveryAction,
  opts: StepRunOpts,
  values: TemplateNamespace,
  failure: StepFailure,
): Promise<StepOutcome> {
  const recoveryValues: TemplateNamespace = {
    inputs: values.inputs,
    steps: values.steps,
    context: { ...values.context, error: failure },
  };
  const step: WorkflowStep = { action };
  const label = stepLabel(step);
  const recoveryPath = [...opts.workflowPath, `${opts.name}:on_failure`];
  const recoveryOpts: StepRunOpts = {
    ...opts,
    workflowPath: recoveryPath,
    recorder: opts.recorder.child({
      name: opts.name,
      workflowPath: recoveryPath,
      parentOrdinal: failure.step_number,
    }),
  };
  await recoveryOpts.recorder.stepStarted(step, 1, 1, label, "recovery");
  const outcome = await executeOnce(step, 0, recoveryValues, recoveryOpts);
  await recoveryOpts.recorder.stepFinished(
    step,
    1,
    1,
    label,
    recordedOutcomeKind(outcome),
    outcome,
    "recovery",
  );
  return outcome;
}

async function finalizeEntryRun(
  primary: StepsResult,
  workflow: LoadedWorkflow,
  opts: StepRunOpts,
  values: TemplateNamespace,
): Promise<StepsResult> {
  if (
    !primary.ok &&
    primary.aborted === true &&
    primary.coordinationLost !== true &&
    workflow.onFailure &&
    primary.failure
  ) {
    const recovery = await runRecovery(workflow.onFailure, opts, values, primary.failure);
    if (!recovery.ok) {
      const error = `${primary.error}; on_failure failed: ${recovery.error}`;
      await opts.recorder.finished(recovery.coordinationLost === true ? "interrupted" : "failed", {
        error,
      });
      return {
        ok: false,
        error,
        aborted: true,
        failure: primary.failure,
        ...(primary.failures !== undefined ? { failures: primary.failures } : {}),
        ...(recovery.coordinationLost === true ? { coordinationLost: true } : {}),
      };
    }
  }
  const returns =
    primary.ok && workflow.returns ? evaluateReturns(workflow.returns, values) : undefined;
  const status = primary.ok
    ? "succeeded"
    : primary.coordinationLost === true
      ? "interrupted"
      : "failed";
  await opts.recorder.finished(status, {
    ...(returns !== undefined ? { returns } : {}),
    ...(!primary.ok ? { error: primary.error } : {}),
  });
  return primary;
}

const IDENTITY_KEYS = ["workspace", "tab", "pane", "worktree"] as const;
const TRANSCRIPT_KEYS = ["transcript", "transcript_file"];

/** Aggregate context keys over the retained child graph (cycle-safe). */
function referencedContextKeys(workflow: LoadedWorkflow, stack: string[] = []): Set<string> {
  const keys = new Set<string>();
  if (stack.includes(workflow.name)) return keys;
  const next = [...stack, workflow.name];
  for (const ref of workflowTemplateRefs(workflow.steps, workflow.returns, workflow.onFailure)) {
    if (ref.root === "context" && ref.segments[0] !== undefined) keys.add(ref.segments[0]);
  }
  for (const child of workflow.children.values()) {
    for (const key of referencedContextKeys(child, next)) keys.add(key);
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
  repoRoot: string;
  inputs: Record<string, string>;
};

type Preflight =
  | { ok: true; values: TemplateNamespace; transcriptFile?: string }
  | { ok: false; error: string };

/** Live name when set; else pane id (Herdr accepts either as agent.prompt/wait target). */
async function invokingAgentTarget(args: PreflightArgs): Promise<string> {
  const paneId = args.ctx.paneId;
  if (!paneId) throw new Error("context.agent needs an invoking herdr pane");
  const info = await args.deps.agentInfo(paneId);
  const name = typeof info.name === "string" ? info.name.trim() : "";
  if (name) return name;
  const kind = typeof info.agent === "string" ? info.agent.trim() : "";
  if (!kind) {
    throw new Error(
      "context.agent is unavailable: no recognized agent in this pane — run this from a pane running a recognized agent",
    );
  }
  return paneId;
}

async function writeTranscriptFile(repoRoot: string, runId: string, text: string): Promise<string> {
  const dir = await ensureRunScratchDir(repoRoot);
  const path = join(dir, `${runId}-transcript.txt`);
  await writeFile(path, text, { mode: 0o600 });
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
    if (keys.has("agent")) agent = await invokingAgentTarget(args);
    if (TRANSCRIPT_KEYS.some((key) => keys.has(key))) {
      const paneId = args.ctx.paneId;
      if (!paneId) return { ok: false, error: "context.transcript needs an invoking herdr pane" };
      transcript = await args.deps.transcriptText(paneId, args.config.transcripts, {
        invocationCwd: args.ctx.cwd,
      });
      if (keys.has("transcript_file")) {
        transcriptFile = await writeTranscriptFile(args.repoRoot, args.runId, transcript);
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
  inputs?: Record<string, string>;
  /** Pre-resolved dynamic choice domains from detached picker launch. */
  domains?: Record<string, string[]>;
  /**
   * Detached `--launch-payload` runs must not resolve missing active dynamics.
   * Defaults to true for direct CLI collection.
   */
  resolveDynamic?: boolean;
  /** Picker-supplied full UUID; generated when absent. */
  runId?: string;
  /** Write machine-readable history ack lines (detached launch channel). */
  onHistoryAck?: (line: string) => void;
  /** Internal test seam — skip claim and inject a recorder handle. */
  recorder?: RunRecorder;
  workflow?: LoadedWorkflow;
  deps?: Partial<RunnerDeps>;
  onProgress?: (step: number, total: number, label: string, outcome?: ProgressOutcome) => void;
  onStderr?: (text: string) => void;
};

export async function runWorkflow(opts: RunOptions): Promise<StepsResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const workflow = opts.workflow ?? (await loadWorkflow(opts.name, opts.repoRoot, opts.config));
  let recorder: RunRecorder;
  if (opts.recorder) {
    recorder = opts.recorder;
  } else {
    const created = await createRunRecorder({
      workflow,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      checkoutRoot: opts.repoRoot,
      ...(opts.onHistoryAck ? { onAck: opts.onHistoryAck } : {}),
    });
    if (!created.ok) return { ok: false, error: created.error };
    recorder = created.recorder;
  }

  const runId = recorder.runId;
  const managedResponseFiles: string[] = [];
  const stepOpts: StepRunOpts = {
    name: workflow.name,
    repoRoot: opts.repoRoot,
    config: opts.config,
    ctx: opts.ctx,
    deps,
    runId,
    workflowPath: [workflow.name],
    children: workflow.children,
    managedResponseFiles,
    runSteps,
    recorder,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
  };

  const failPrecondition = async (detail: string): Promise<StepsResult> => {
    const error = await fail(deps, workflow.name, 0, detail);
    await recorder.finished("failed", { error });
    return { ok: false, error };
  };

  let transcriptFile: string | undefined;
  let succeeded = false;
  try {
    const inputs = await completeWorkflowInputs(workflow, {
      provided: opts.inputs,
      domains: opts.domains,
      config: opts.config,
      repoRoot: opts.repoRoot,
      resolveDynamic: opts.resolveDynamic !== false,
    });
    if (!inputs.ok) return await failPrecondition(inputs.error);

    try {
      assertHwfEnvValues("HWF environment", inputs.values);
    } catch (error) {
      return await failPrecondition(errorText(error));
    }

    const context = await preflightContext({
      workflow,
      ctx: opts.ctx,
      config: opts.config,
      deps,
      runId,
      repoRoot: opts.repoRoot,
      inputs: inputs.values,
    });
    if (!context.ok) return await failPrecondition(context.error);
    transcriptFile = context.transcriptFile;

    const primary = await runSteps(workflow.steps, stepOpts, context.values);
    const final = await finalizeEntryRun(primary, workflow, stepOpts, context.values);
    succeeded = final.ok;
    return final;
  } finally {
    recorder.dispose();
    if (transcriptFile) await rm(transcriptFile, { force: true }).catch(() => undefined);
    // A failed step leaves its agent still working, so its answer is the only
    // artifact left to read. Keep it in gitignored .hwf/tmp for the user.
    if (succeeded) {
      await Promise.all(
        managedResponseFiles.map((path) => rm(path, { force: true }).catch(() => undefined)),
      );
    }
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
