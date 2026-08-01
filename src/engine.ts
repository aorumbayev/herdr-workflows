import { closeSync, mkdirSync, openSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { z } from "zod";
import {
  assertUnderCaptureCap,
  CAPTURE_BYTE_LIMIT,
  CaptureLimitError,
  configPathsHint,
  globalConfigPath,
  repoConfigPath,
  resolveProfile,
  AGENT_PROMPT_BYTE_LIMIT,
  assertHwfEnvValues,
  pluginStateDir,
  ensureLocalConfigGitignored,
  transcriptText,
  type InvocationContext,
  type TranscriptExtractor,
  type WorkflowsConfig,
  type AgentProfile,
} from "./context";
import {
  buildTemplateNamespace,
  completeWorkflowInputs,
  evaluateWhen,
  loadWorkflow,
  workflowTemplateRefs,
} from "./workflow/inputs";
import { createRunRecorder, type RunRecorder, type RunStepOutcomeKind } from "./history";
import {
  HerdrError,
  validateHerdrInvocation,
  agentStatus,
  herdrCall,
  notificationShow,
  paneClose,
  reportToken,
  tabClose,
} from "./host";
import {
  substituteParams,
  renderScalar,
  substituteText,
  substituteValue,
} from "./workflow/grammar";
import type {
  TemplateNamespace,
  WorkflowStep,
  PaneOpen,
  ShellName,
  StepAction,
  LoadedWorkflow,
  ReturnsSpec,
  RecoveryAction,
} from "./workflow/grammar";

type StepFailure = {
  message: string;
  workflow: string;
  action: "agent" | "run" | "herdr" | "workflow";
  step_number: number;
  workflow_path: string[];
  step_id?: string;
  details: Record<string, unknown>;
};

type StepOutcome =
  | { ok: true; result?: unknown; launched?: boolean }
  | {
      ok: false;
      error: string;
      details?: Record<string, unknown>;
      coordinationLost?: boolean;
      hardFailure?: boolean;
      failure?: StepFailure;
    };

export type RunnerDeps = {
  herdrCall: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notificationShow: (title: string, body?: string) => Promise<void>;
  agentStatus: (target: string) => Promise<string>;
  agentInfo: (target: string) => Promise<Record<string, unknown>>;
  paneClose: (paneId: string) => Promise<void>;
  tabClose: (tabId: string) => Promise<void>;
  reportToken: (paneId: string, value: string | null) => Promise<void>;
  transcriptText: (
    paneId: string,
    transcripts: Record<string, TranscriptExtractor>,
    opts: { invocationCwd: string; projectsBase?: string },
  ) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  responseDir?: string;
};

type StepRunOpts = {
  name: string;
  repoRoot: string;
  config: WorkflowsConfig;
  ctx: InvocationContext;
  deps: RunnerDeps;
  runId: string;
  workflowPath: string[];
  managedResponseFiles: string[];
  recorder: RunRecorder;
  onProgress?: (step: number, total: number, label: string, outcome?: string) => void;
  onStderr?: (text: string) => void;
  runSteps: RunSteps;
};

type StepCtx = {
  step: WorkflowStep;
  stepIndex: number;
  values: TemplateNamespace;
  opts: StepRunOpts;
};

export type StepsResult =
  | { ok: true; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      aborted?: boolean;
      coordinationLost?: boolean;
      failure?: StepFailure;
    };

type RunSteps = (
  steps: WorkflowStep[],
  opts: StepRunOpts,
  values: TemplateNamespace,
) => Promise<StepsResult>;

const COORDINATION_CODES = new Set(["closed", "no_socket", "unreachable"]);

export class CoordinationError extends Error {
  constructor(action: string, detail: string) {
    super(
      `${action}: herdr coordination was lost (${detail}) — the action may still be active; panes were preserved and on_failure was skipped`,
    );
    this.name = "CoordinationError";
  }
}

export function isCoordinationError(err: unknown): boolean {
  return err instanceof HerdrError && COORDINATION_CODES.has(err.code);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap a dispatched herdr operation so transport loss becomes an uncertain-coordination outcome. */
function dispatchFailure(action: string, err: unknown): StepOutcome {
  if (isCoordinationError(err)) {
    return {
      ok: false,
      error: new CoordinationError(action, errorText(err)).message,
      coordinationLost: true,
    };
  }
  return { ok: false, error: `${action}: ${errorText(err)}` };
}

/** Herdr split ratio is the first child's share and the created pane is the second child. */
export function sizeToFirstRatio(sizePercent: number): number {
  return (100 - sizePercent) / 100;
}

const AGENT_NAME_MAX = 32;

function normalizedPrefix(raw: string): string {
  const lowered = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "");
  return lowered || "agent";
}

export function generateAgentName(
  stepId: string | undefined,
  ordinal: number,
  suffix: string,
): string {
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "") || "0";
  const prefix = normalizedPrefix(stepId ?? `step-${ordinal}`);
  const room = Math.max(1, AGENT_NAME_MAX - tail.length - 1);
  return `${prefix.slice(0, room)}-${tail}`.slice(0, AGENT_NAME_MAX);
}

/** Repo-local scratch for agent-readable/writable run files (transcripts, prompts, responses). */
function runScratchDir(repoRoot: string): string {
  return join(repoRoot, ".hwf", "tmp");
}

function managedResponsePath(runId: string, stepIndex: number, responseDir: string): string {
  return join(responseDir, `${runId}-step-${stepIndex}.txt`);
}

/** Spill path for agent.prompt bodies that exceed AGENT_PROMPT_BYTE_LIMIT. */
function managedPromptSpillPath(runId: string, stepIndex: number, responseDir: string): string {
  return join(responseDir, `${runId}-step-${stepIndex}-prompt.txt`);
}

function appendResponseInstruction(prompt: string, path: string): string {
  return `${prompt}\n\nRequired: use your file-write tool to write your full answer as plain UTF-8 text to the absolute path ${path}, overwriting whatever is there. Do not finish until that file exists with your answer. Write nothing else to that path and do not create other files for it. Printing the answer in chat is not enough.`;
}

function spilledPromptInstruction(spillPath: string): string {
  return `Read the absolute path ${spillPath} as UTF-8 and follow its instructions exactly. Do not invent content beyond that file.`;
}

export async function readManagedResponse(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError(
      "managed_response_missing",
      `managed response file was not written: ${path}`,
    );
  }
  const size = file.size;
  if (size > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError("managed response", size);
  const text = await file.text();
  assertUnderCaptureCap("managed response", text);
  if (!text.trim()) {
    throw new HerdrError("managed_response_empty", `managed response file is empty: ${path}`);
  }
  return text;
}

async function herdrStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "herdr") return { ok: false, error: "internal: not a herdr step" };
  const params = substituteParams(action.params, c.values) ?? {};
  const invalid = validateHerdrInvocation(action.method, params);
  if (invalid) return { ok: false, error: invalid, details: { method: action.method } };
  try {
    const result = await c.opts.deps.herdrCall(action.method, params);
    return { ok: true, result };
  } catch (error) {
    const failure = dispatchFailure(`herdr ${action.method}`, error);
    return failure.ok ? failure : { ...failure, details: { method: action.method } };
  }
}

export type PlacedPane = { pane_id: string; tab_id: string; workspace_id: string };

type PlaceAnchors = { paneId?: string; tabId?: string; workspaceId?: string };

export type PlaceOpts = {
  open: PaneOpen;
  target?: string;
  workspace?: string;
  size?: number;
  focus: boolean;
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
  deps: { herdrCall: RunnerDeps["herdrCall"] };
  invocation: PlaceAnchors;
};

type PaneInfoish = { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown };

function failPlacement(detail: string): never {
  throw new HerdrError("placement_failed", detail);
}

function requireWorkspace(o: PlaceOpts): string {
  const workspace = o.workspace ?? o.invocation.workspaceId;
  if (!workspace) failPlacement("pane.open: tab needs pane.workspace or an invocation workspace");
  return workspace;
}

function requireTargetPane(o: PlaceOpts): string {
  const target = o.target ?? o.invocation.paneId;
  if (!target) failPlacement(`pane.open: ${o.open} needs pane.target or an invocation pane`);
  return target;
}

function splitDirection(open: PaneOpen): "right" | "down" {
  return open === "beside" ? "right" : "down";
}

function placedFrom(source: unknown, where: string): PlacedPane {
  const info = (source ?? {}) as PaneInfoish;
  const paneId = info.pane_id;
  const tabId = info.tab_id;
  const workspaceId = info.workspace_id;
  if (typeof paneId !== "string" || typeof tabId !== "string" || typeof workspaceId !== "string") {
    failPlacement(`${where} did not return pane/tab/workspace identifiers`);
  }
  return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

/** Empty shell pane for a managed agent: tab.create for tabs, pane.split for beside/below. */
async function placeEmptyPane(o: PlaceOpts): Promise<PlacedPane> {
  if (o.open === "tab") {
    const result = await o.deps.herdrCall("tab.create", {
      workspace_id: requireWorkspace(o),
      cwd: o.cwd ?? null,
      env: o.env ?? {},
      focus: o.focus,
      label: o.label ?? null,
    });
    const tab = (result.tab ?? {}) as PaneInfoish;
    const pane = placedFrom(result.root_pane, "tab.create");
    return {
      pane_id: pane.pane_id,
      tab_id: typeof tab.tab_id === "string" ? tab.tab_id : pane.tab_id,
      workspace_id: typeof tab.workspace_id === "string" ? tab.workspace_id : pane.workspace_id,
    };
  }
  const result = await o.deps.herdrCall("pane.split", {
    direction: splitDirection(o.open),
    target_pane_id: requireTargetPane(o),
    ratio: o.size !== undefined ? sizeToFirstRatio(o.size) : null,
    cwd: o.cwd ?? null,
    env: o.env ?? {},
    focus: o.focus,
  });
  return placedFrom(result.pane, "pane.split");
}

type LayoutNodeish = {
  pane_id?: unknown;
  second?: LayoutNodeish;
};

type LayoutResult = {
  tab_id?: unknown;
  workspace_id?: unknown;
  focused_pane_id?: unknown;
  root?: LayoutNodeish;
};

function createdPaneId(layout: LayoutResult, split: boolean): string {
  const node = split ? layout.root?.second : layout.root;
  const fromTree = node?.pane_id;
  if (typeof fromTree === "string") return fromTree;
  if (typeof layout.focused_pane_id === "string") return layout.focused_pane_id;
  return failPlacement("layout.apply did not return the created pane id");
}

function layoutPlacement(result: Record<string, unknown>, split: boolean): PlacedPane {
  const layout = (result.layout ?? {}) as LayoutResult;
  const tabId = layout.tab_id;
  const workspaceId = layout.workspace_id;
  if (typeof tabId !== "string" || typeof workspaceId !== "string") {
    failPlacement("layout.apply did not return tab/workspace identifiers");
  }
  return { pane_id: createdPaneId(layout, split), tab_id: tabId, workspace_id: workspaceId };
}

/** Quote argv for submission into an interactive shell via pane.send_input. */
export function quoteArgvForShell(argv: string[]): string {
  return argv.map(quotePosixArg).join(" ");
}

function quotePosixArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pane running a command.
 * - `open: tab` uses layout.apply with a command leaf (true argv, no shell).
 * - `open: beside|below` uses pane.split (preserves the anchor process) then
 *   pane.send_input with a shell-quoted command line — Herdr has no pane.run
 *   socket method, and layout.apply replaces the tab without preserving PTYs.
 */
export async function placeCommandPane(o: PlaceOpts & { argv: string[] }): Promise<PlacedPane> {
  if (o.open === "tab") {
    const result = await o.deps.herdrCall("layout.apply", {
      workspace_id: requireWorkspace(o),
      tab_label: o.label ?? null,
      tab_id: null,
      focus: o.focus,
      root: {
        type: "pane",
        label: o.label ?? null,
        cwd: o.cwd ?? null,
        command: o.argv,
        env: o.env ?? {},
      },
    });
    return layoutPlacement(result, false);
  }
  const placed = await placeEmptyPane(o);
  await o.deps.herdrCall("pane.send_input", {
    pane_id: placed.pane_id,
    text: quoteArgvForShell(o.argv),
    keys: ["Enter"],
  });
  return placed;
}

type RunAction = Extract<StepAction, { kind: "run" }>;

function resolvePaneOpen(open: string, ns: TemplateNamespace): PaneOpen {
  if (open === "tab" || open === "beside" || open === "below") return open;
  const resolved = substituteValue(open, ns);
  if (resolved === "tab" || resolved === "beside" || resolved === "below") return resolved;
  throw new Error(
    `pane.open resolved to '${renderScalar(resolved)}' (expected tab, beside, or below)`,
  );
}

type CaptureBudget = {
  source: string;
  limit: number;
  total: number;
  onOverflow: () => void;
};

async function readStreamAgainstBudget(
  stream: ReadableStream<Uint8Array> | null,
  budget?: CaptureBudget,
): Promise<string> {
  if (!stream) return "";
  if (!budget) return new Response(stream).text();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    budget.total += value.byteLength;
    if (budget.total > budget.limit) {
      budget.onOverflow();
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw new CaptureLimitError(budget.source, budget.total, budget.limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function shellArgv(command: string, shell: ShellName = "sh"): string[] {
  switch (shell) {
    case "sh":
      return ["sh", "-c", command];
    case "bash":
      return ["bash", "-c", command];
    case "zsh":
      return ["zsh", "-c", command];
    case "pwsh":
      return ["pwsh", "-NoProfile", "-Command", command];
    case "powershell":
      return ["powershell", "-NoProfile", "-Command", command];
    case "cmd":
      return ["cmd", "/c", command];
  }
}

export function killSpawn(proc: { pid: number; kill: () => void }): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
}

export type CaptureResult = {
  timedOut: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timeoutMs: number;
};

/** `timeoutMs` omitted means no workflow timeout; process completion still blocks. */
export async function spawnCapture(
  argv: string[],
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxCaptureBytes?: { source: string };
  },
): Promise<CaptureResult> {
  const timeoutMs = opts.timeoutMs ?? 0;
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    detached: true,
  });
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killSpawn(proc);
        }, timeoutMs)
      : undefined;

  const budget = opts.maxCaptureBytes
    ? {
        source: opts.maxCaptureBytes.source,
        limit: CAPTURE_BYTE_LIMIT,
        total: 0,
        onOverflow: () => killSpawn(proc),
      }
    : undefined;

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamAgainstBudget(proc.stdout, budget),
      readStreamAgainstBudget(proc.stderr, budget),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { timedOut, exitCode: exitCode ?? 1, stdout, stderr, timeoutMs };
  } catch (error) {
    clearTimeout(timer);
    killSpawn(proc);
    throw error;
  }
}

type CommandOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  failed: boolean;
};

function captureResult(r: CaptureResult, successCodes: number[] = [0]): CommandOutcome {
  const accepted = !r.timedOut && successCodes.includes(r.exitCode);
  const failed = !accepted;
  const stderr = r.timedOut && !r.stderr ? `timed out after ${r.timeoutMs / 1000}s` : r.stderr;
  return {
    ok: accepted,
    stdout: r.stdout,
    stderr,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    failed,
  };
}

const COMMAND_CAPTURE_SOURCE = "command output";

export async function runShellStep(
  command: string,
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: ShellName;
    successCodes?: number[];
  },
): Promise<CommandOutcome> {
  return captureResult(
    await spawnCapture(shellArgv(command, opts.shell), {
      cwd: opts.cwd,
      stdin: opts.stdin,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxCaptureBytes: { source: COMMAND_CAPTURE_SOURCE },
    }),
    opts.successCodes,
  );
}

export async function runArgvStep(
  argv: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    successCodes?: number[];
  },
): Promise<CommandOutcome> {
  return captureResult(
    await spawnCapture(argv, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxCaptureBytes: { source: COMMAND_CAPTURE_SOURCE },
    }),
    opts.successCodes,
  );
}

export function buildHwfEnv(inputs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [`HWF_${name}`, renderScalar(value)]),
  );
}

const RESERVED_ENV_RE = /^hwf_/i;

type StepEnv = { ok: true; env: Record<string, string> } | { ok: false; error: string };

function stepEnvValues(env: Record<string, string> | undefined, ns: TemplateNamespace): StepEnv {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (RESERVED_ENV_RE.test(key)) {
      return { ok: false, error: `env key '${key}' uses the reserved HWF_ prefix` };
    }
    out[key] = substituteText(value, ns);
  }
  return { ok: true, env: out };
}

/** Runner-generated HWF values replace inherited collisions; explicit `env:` wins over both. */
export function mergeStepEnv(
  inherited: NodeJS.ProcessEnv,
  hwf: Record<string, string>,
  stepEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...inherited, ...hwf, ...stepEnv };
}

function commandArgv(action: RunAction, ns: TemplateNamespace): string[] {
  const payload = action.payload;
  if (payload.form === "argv") return payload.argv.map((el) => substituteText(el, ns));
  return shellArgv(payload.command, payload.shell);
}

function bindCommandResult(c: StepCtx, outcome: CommandOutcome): void {
  if (!c.step.id) return;
  c.values.steps[c.step.id] = {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.exitCode,
    failed: outcome.failed,
  };
}

function commandFailure(outcome: CommandOutcome): Extract<StepOutcome, { ok: false }> {
  const detail = outcome.stderr.trim() || outcome.stdout.trim().slice(-500);
  return {
    ok: false,
    error: detail || `exit ${outcome.exitCode}`,
    details: {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exit_code: outcome.exitCode,
    },
  };
}

async function localRun(
  c: StepCtx,
  action: RunAction,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<StepOutcome> {
  const payload = action.payload;
  const successCodes = action.successCodes ?? [0];
  let outcome: CommandOutcome;
  try {
    outcome =
      payload.form === "argv"
        ? await runArgvStep(commandArgv(action, c.values), {
            cwd,
            env,
            timeoutMs: action.timeoutMs,
            successCodes,
          })
        : await runShellStep(payload.command, {
            cwd,
            env,
            timeoutMs: action.timeoutMs,
            shell: payload.shell,
            successCodes,
          });
  } catch (error) {
    if (error instanceof CaptureLimitError) {
      return { ok: false, error: error.message, hardFailure: true };
    }
    return { ok: false, error: `run: ${errorText(error)}`, hardFailure: true };
  }
  if (outcome.stderr) c.opts.onStderr?.(outcome.stderr);
  if (outcome.timedOut) return { ...commandFailure(outcome), hardFailure: true };
  bindCommandResult(c, outcome);
  return outcome.failed ? commandFailure(outcome) : { ok: true };
}

const READY_LINES = 80;

async function placedRun(
  c: StepCtx,
  action: RunAction,
  cwd: string,
  paneEnv: Record<string, string>,
): Promise<StepOutcome> {
  const pane = action.pane;
  if (!pane) return { ok: false, error: "run: background and ready_when require pane:" };
  const sub = (text?: string) => (text === undefined ? undefined : substituteText(text, c.values));
  let open: PaneOpen;
  try {
    open = resolvePaneOpen(pane.open, c.values);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  const placed = await placeCommandPane({
    open,
    target: sub(pane.target),
    workspace: sub(pane.workspace),
    size: pane.size,
    focus: pane.focus ?? action.background !== true,
    cwd,
    env: paneEnv,
    label: c.step.id ?? "hwf-run",
    argv: commandArgv(action, c.values),
    deps: c.opts.deps,
    invocation: c.opts.ctx,
  });
  if (action.background === true) return { ok: true, launched: true };
  if (action.readyWhen === undefined || action.timeoutMs === undefined) {
    return { ok: false, error: "run: placed foreground run requires ready_when and timeout" };
  }
  const waited = await c.opts.deps.herdrCall("pane.wait_for_output", {
    pane_id: placed.pane_id,
    source: "recent",
    lines: READY_LINES,
    strip_ansi: true,
    match: { type: "regex", value: action.readyWhen },
    timeout_ms: action.timeoutMs,
  });
  return { ok: true, result: { ...waited, ...placed } };
}

async function shellStep(c: StepCtx & { env: NodeJS.ProcessEnv }): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "run") return { ok: false, error: "internal: not a run step" };
  const stepEnv = stepEnvValues(action.env, c.values);
  if (!stepEnv.ok) return { ok: false, error: stepEnv.error };
  const hwf = buildHwfEnv(c.values.inputs);
  const cwd = action.cwd !== undefined ? substituteText(action.cwd, c.values) : c.opts.ctx.cwd;
  if (action.pane || action.background === true || action.readyWhen !== undefined) {
    try {
      return await placedRun(c, action, cwd, { ...hwf, ...stepEnv.env });
    } catch (error) {
      return dispatchFailure("run", error);
    }
  }
  return localRun(c, action, cwd, mergeStepEnv(c.env, hwf, stepEnv.env));
}

type AgentAction = Extract<StepAction, { kind: "agent" }>;

const TURN_TIMEOUT_MS = 1_800_000;
const POLL_MS = 1_000;
const SETTLED = new Set(["idle", "done"]);
/** New-agent only: consecutive settled+empty polls before missing-response failure. */
const SETTLED_EMPTY_GRACE_POLLS = 2;
const SHELL_READY_DEADLINE_MS = 5_000;
const SHELL_READY_POLL_MS = 50;
/** Socket agent.start returns at launch_pending; CLI waits for interactive_ready (default 30s). */
const AGENT_INTERACTIVE_DEADLINE_MS = 30_000;
const AGENT_INTERACTIVE_POLL_MS = 100;
/**
 * Fresh agents (esp. opencode) can report interactive_ready before they accept input.
 * Wait this long after each agent.prompt for status to leave idle.
 */
const SUBMIT_PICKUP_DEADLINE_MS = 10_000;
const SUBMIT_PICKUP_POLL_MS = 100;
/** After pickup wait fails, Enter once for bracketed-paste stall, then wait again briefly. */
const SUBMIT_ENTER_FOLLOWUP_MS = 5_000;
const SUBMIT_MAX_ATTEMPTS = 3;
const SUBMIT_RETRY_BACKOFF_MS = 2_000;

function processInfoRecord(result: Record<string, unknown>): Record<string, unknown> {
  const info = result.process_info;
  return typeof info === "object" && info !== null ? (info as Record<string, unknown>) : result;
}

/** shell_pid alone in its FG group — herdr available_pane_shell via pane.process_info. */
function isAvailableShellProcessInfo(info: Record<string, unknown>): boolean {
  const shellPid = info.shell_pid;
  if (typeof shellPid !== "number") return false;
  if (info.foreground_process_group_id !== shellPid) return false;
  const procs = info.foreground_processes;
  if (!Array.isArray(procs) || procs.length !== 1) return false;
  const only = procs[0];
  return typeof only === "object" && only !== null && (only as { pid?: unknown }).pid === shellPid;
}

async function startAgentWhenShellReady(
  deps: RunnerDeps,
  params: { name: string; kind: string; pane_id: string; args: string[] },
): Promise<void> {
  const deadline = deps.now() + SHELL_READY_DEADLINE_MS;
  let lastBusy: HerdrError | undefined;
  while (deps.now() < deadline) {
    let shellReady = false;
    try {
      const result = await deps.herdrCall("pane.process_info", { pane_id: params.pane_id });
      shellReady = isAvailableShellProcessInfo(processInfoRecord(result));
    } catch {
      shellReady = false;
    }
    if (shellReady) {
      try {
        await deps.herdrCall("agent.start", params);
        return;
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
        lastBusy = error;
      }
    }
    await deps.sleep(SHELL_READY_POLL_MS);
  }
  if (lastBusy) throw lastBusy;
  await deps.herdrCall("agent.start", params);
}

async function awaitAgentInteractiveReady(deps: RunnerDeps, name: string): Promise<void> {
  const deadline = deps.now() + AGENT_INTERACTIVE_DEADLINE_MS;
  for (;;) {
    const agent = await deps.agentInfo(name);
    if (agent.interactive_ready === true) return;
    if (agent.launch_pending === false) {
      throw new HerdrError(
        "agent_start_failed",
        "agent process exited before becoming interactive",
      );
    }
    if (deps.now() >= deadline) {
      throw new HerdrError(
        "agent_start_timeout",
        `agent '${name}' did not become interactive within ${AGENT_INTERACTIVE_DEADLINE_MS / 1000}s`,
      );
    }
    await deps.sleep(AGENT_INTERACTIVE_POLL_MS);
  }
}

type ProfileChoice =
  | { ok: true; name: string; profile: AgentProfile }
  | { ok: false; error: string };

/** Target mode keeps waiting for the exact managed file; new-agent fails after a short settled grace. */
type ManagedWaitMode = "new-agent" | "target";

async function chooseProfile(c: StepCtx, action: AgentAction): Promise<ProfileChoice> {
  const name =
    action.using !== undefined
      ? substituteText(action.using, c.values)
      : c.opts.config.default_profile;
  if (!name) {
    const hint = configPathsHint(await globalConfigPath(), repoConfigPath(c.opts.repoRoot));
    return {
      ok: false,
      error: `agent: no using: profile and no default_profile is configured (${hint}); run \`hwf init\` or \`hwf init --global\``,
    };
  }
  const profile = resolveProfile(c.opts.config, name);
  if (!profile) return { ok: false, error: `agent: unknown profile '${name}'` };
  return { ok: true, name, profile };
}

function responseDirOf(c: StepCtx): string {
  return c.opts.deps.responseDir ?? runScratchDir(c.opts.repoRoot);
}

async function preparedResponsePath(c: StepCtx): Promise<string> {
  const path = managedResponsePath(c.opts.runId, c.stepIndex, responseDirOf(c));
  await mkdir(dirname(path), { recursive: true });
  c.opts.managedResponseFiles.push(path);
  return path;
}

async function fileHasText(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return (await file.exists()) && file.size > 0;
}

async function missingManagedError(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return `managed response file was not written: ${path}`;
  return `managed response file is empty: ${path}`;
}

type TurnWait = { settled: true } | { settled: false; error: string };

async function awaitManagedTurn(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
): Promise<TurnWait> {
  const deps = c.opts.deps;
  const deadline = deps.now() + timeoutMs;
  let notifiedBlocked = false;
  let sawActive = false;
  let settledEmptyPolls = 0;
  for (;;) {
    const status = await deps.agentStatus(target);
    const hasText = await fileHasText(path);
    if (SETTLED.has(status) && hasText) return { settled: true };
    if (!SETTLED.has(status)) sawActive = true;

    // Skip pre-work idle: agent.start leaves the agent idle until the prompt is taken.
    const emptySettled =
      mode === "new-agent" && SETTLED.has(status) && !hasText && (status === "done" || sawActive);
    if (emptySettled) {
      settledEmptyPolls += 1;
      if (settledEmptyPolls > SETTLED_EMPTY_GRACE_POLLS) {
        return { settled: false, error: await missingManagedError(path) };
      }
    } else {
      settledEmptyPolls = 0;
    }

    if (status !== "blocked") notifiedBlocked = false;
    else if (!notifiedBlocked) {
      notifiedBlocked = true;
      await deps
        .notificationShow(
          `herdr-workflows: ${c.opts.name} agent blocked`,
          `${target} is waiting for input at step ${c.stepIndex}`,
        )
        .catch(() => undefined);
    }

    if (deps.now() >= deadline) {
      return {
        settled: false,
        error: `agent turn on '${target}' did not settle with a managed response within ${timeoutMs / 1000}s (last status ${status})`,
      };
    }
    await deps.sleep(POLL_MS);
  }
}

function agentDetails(parts: {
  profile?: string;
  kind?: string;
  target?: string;
  pane?: PlacedPane;
  pane_id?: string;
  status?: string;
}): Record<string, unknown> {
  return {
    ...(parts.profile !== undefined ? { profile: parts.profile } : {}),
    ...(parts.kind !== undefined ? { kind: parts.kind } : {}),
    ...(parts.target !== undefined ? { target: parts.target } : {}),
    ...(parts.pane
      ? {
          pane_id: parts.pane.pane_id,
          tab_id: parts.pane.tab_id,
          workspace_id: parts.pane.workspace_id,
        }
      : {}),
    ...(parts.pane_id !== undefined && !parts.pane ? { pane_id: parts.pane_id } : {}),
    ...(parts.status !== undefined ? { status: parts.status } : {}),
  };
}

async function managedResult(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
  details: Record<string, unknown>,
): Promise<StepOutcome> {
  const wait = await awaitManagedTurn(c, target, path, timeoutMs, mode);
  if (!wait.settled) {
    return { ok: false, error: wait.error, details };
  }
  try {
    const response = await readManagedResponse(path);
    const agent = await c.opts.deps.agentInfo(target);
    const pane =
      typeof details.pane_id === "string"
        ? details.pane_id
        : typeof agent.pane_id === "string"
          ? agent.pane_id
          : "";
    return { ok: true, result: { response, agent, pane_id: pane } };
  } catch (error) {
    const message =
      error instanceof HerdrError ? error.message : `managed response: ${String(error)}`;
    return { ok: false, error: message, details };
  }
}

/** Evidence the agent accepted input (not still sitting on a pristine idle welcome). */
function promptPickedUp(status: string, before: string): boolean {
  if (status === "working" || status === "blocked") return true;
  return status !== "idle" && status !== before;
}

async function waitForPromptPickup(
  deps: RunnerDeps,
  target: string,
  before: string,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = deps.now() + deadlineMs;
  while (deps.now() < deadline) {
    const status = await deps.agentStatus(target);
    if (promptPickedUp(status, before)) return true;
    await deps.sleep(SUBMIT_PICKUP_POLL_MS);
  }
  return promptPickedUp(await deps.agentStatus(target), before);
}

/** Spill oversized bodies so agent.prompt does not silently drop them. */
async function maybeSpillAgentPrompt(c: StepCtx, text: string): Promise<string> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= AGENT_PROMPT_BYTE_LIMIT) return text;
  assertUnderCaptureCap("agent prompt", text);
  const spill = managedPromptSpillPath(c.opts.runId, c.stepIndex, responseDirOf(c));
  await mkdir(dirname(spill), { recursive: true, mode: 0o700 });
  await writeFile(spill, text, { mode: 0o600 });
  c.opts.managedResponseFiles.push(spill);
  return spilledPromptInstruction(spill);
}

/**
 * Submit until the agent leaves idle, re-sending the full prompt when a cold agent drops it.
 * Enter nudge only handles the separate bracketed-paste case (text present, not submitted).
 */
async function submitPrompt(c: StepCtx, target: string, text: string): Promise<void> {
  const deps = c.opts.deps;
  const body = await maybeSpillAgentPrompt(c, text);
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    // A slow-but-successful earlier submit may land during backoff — never double-prompt.
    if (attempt > 1 && promptPickedUp(await deps.agentStatus(target), "idle")) return;
    const before = await deps.agentStatus(target);
    await deps.herdrCall("agent.prompt", { target, text: body });
    if (await waitForPromptPickup(deps, target, before, SUBMIT_PICKUP_DEADLINE_MS)) return;
    // Paste stall: text may be in the composer without an Enter. Never re-prompt if this wakes it.
    await deps.herdrCall("agent.send_keys", { target, keys: ["enter"] });
    if (await waitForPromptPickup(deps, target, before, SUBMIT_ENTER_FOLLOWUP_MS)) return;
    if (attempt < SUBMIT_MAX_ATTEMPTS) await deps.sleep(SUBMIT_RETRY_BACKOFF_MS);
  }
  throw new HerdrError(
    "agent_prompt_stalled",
    `agent prompt to '${target}' was not accepted after ${SUBMIT_MAX_ATTEMPTS} attempts — agent never left idle (interactive_ready can be premature)`,
  );
}

async function closePane(c: StepCtx, placed: PlacedPane): Promise<void> {
  await c.opts.deps.paneClose(placed.pane_id).catch(() => undefined);
}

async function placeNewAgentPane(
  c: StepCtx,
  action: AgentAction,
): Promise<{ name: string; placed: PlacedPane }> {
  const pane = action.pane ?? { open: "tab" as const };
  const sub = (text?: string) => (text === undefined ? undefined : substituteText(text, c.values));
  const placed = await placeEmptyPane({
    open: resolvePaneOpen(pane.open, c.values),
    target: sub(pane.target),
    workspace: sub(pane.workspace),
    size: pane.size,
    focus: pane.focus ?? action.background !== true,
    cwd: action.cwd !== undefined ? substituteText(action.cwd, c.values) : c.opts.ctx.cwd,
    env: Object.fromEntries(
      Object.entries(action.env ?? {}).map(([k, v]) => [k, substituteText(v, c.values)]),
    ),
    label: c.step.id ?? "hwf-agent",
    deps: c.opts.deps,
    invocation: c.opts.ctx,
  });
  return {
    name: generateAgentName(c.step.id, c.stepIndex, c.opts.runId),
    placed,
  };
}

async function bootNewAgent(
  deps: RunnerDeps,
  name: string,
  profile: AgentProfile,
  placed: PlacedPane,
): Promise<void> {
  await startAgentWhenShellReady(deps, {
    name,
    kind: profile.kind,
    pane_id: placed.pane_id,
    args: profile.args ?? [],
  });
  await awaitAgentInteractiveReady(deps, name);
}

async function newAgentTurn(c: StepCtx, action: AgentAction): Promise<StepOutcome> {
  const chosen = await chooseProfile(c, action);
  if (!chosen.ok) return { ok: false, error: chosen.error };
  let placement: { name: string; placed: PlacedPane } | undefined;
  const close = action.pane?.close;
  const baseDetails = () =>
    agentDetails({
      profile: chosen.name,
      kind: chosen.profile.kind,
      ...(placement ? { target: placement.name, pane: placement.placed } : {}),
    });
  try {
    placement = await placeNewAgentPane(c, action);
    await bootNewAgent(c.opts.deps, placement.name, chosen.profile, placement.placed);
    const prompt = substituteText(action.prompt, c.values);
    if (action.background === true) {
      await submitPrompt(c, placement.name, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(c);
    await submitPrompt(c, placement.name, appendResponseInstruction(prompt, path));
    const outcome = await managedResult(
      c,
      placement.name,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      "new-agent",
      baseDetails(),
    );
    if (outcome.ok && close === "success") await closePane(c, placement.placed);
    return outcome;
  } catch (error) {
    const failure = dispatchFailure(`agent (profile ${chosen.name})`, error);
    return failure.ok ? failure : { ...failure, details: baseDetails() };
  } finally {
    if (close === "always" && placement) await closePane(c, placement.placed);
  }
}

async function targetTurn(
  c: StepCtx,
  action: AgentAction,
  rawTarget: string,
): Promise<StepOutcome> {
  const target = substituteText(rawTarget, c.values);
  if (!target) return { ok: false, error: "agent: target resolved to an empty value" };
  const details = agentDetails({ target });
  try {
    const status = await c.opts.deps.agentStatus(target);
    if (!SETTLED.has(status)) {
      return {
        ok: false,
        error: `agent target '${target}' is ${status} — herdr cannot correlate a queued turn; use 'herdr: agent.prompt' to queue work deliberately`,
        details: agentDetails({ target, status }),
      };
    }
    const prompt = substituteText(action.prompt, c.values);
    if (action.background === true) {
      await submitPrompt(c, target, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(c);
    await submitPrompt(c, target, appendResponseInstruction(prompt, path));
    return await managedResult(
      c,
      target,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      "target",
      details,
    );
  } catch (error) {
    const failure = dispatchFailure(`agent (target ${target})`, error);
    return failure.ok ? failure : { ...failure, details };
  }
}

async function agentStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "agent") return { ok: false, error: "internal: not an agent step" };
  if (action.target !== undefined) return targetTurn(c, action, action.target);
  return newAgentTurn(c, action);
}

type WorkflowActionSpec = Extract<StepAction, { kind: "workflow" }>;

type ResolvedInputs = { ok: true; values: Record<string, string> } | { ok: false; error: string };

function evaluateReturns(returns: ReturnsSpec, ns: TemplateNamespace): unknown {
  if (returns.kind === "template") return substituteValue(returns.template, ns);
  return Object.fromEntries(
    Object.entries(returns.fields).map(([name, template]) => [name, substituteValue(template, ns)]),
  );
}

async function workflowStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "workflow") return { ok: false, error: "internal: not a workflow step" };
  return runChild(c, action);
}

async function runChild(c: StepCtx, action: WorkflowActionSpec): Promise<StepOutcome> {
  const repoRoot = c.opts.repoRoot;
  let child: LoadedWorkflow;
  try {
    child = await loadWorkflow(action.name, repoRoot, c.opts.config);
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }
  const passed = Object.fromEntries(
    Object.entries(action.inputs ?? {}).map(([name, template]) => [
      name,
      substituteText(template, c.values),
    ]),
  );
  let inputs: ResolvedInputs;
  try {
    const collected = await completeWorkflowInputs(child, {
      provided: passed,
      config: c.opts.config,
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
    context: c.values.context,
  };
  const childPath = [...c.opts.workflowPath, child.name];
  const result = await c.opts.runSteps(
    child.steps,
    {
      ...c.opts,
      name: child.name,
      workflowPath: childPath,
      recorder: c.opts.recorder.child({
        name: child.name,
        workflowPath: childPath,
        parentOrdinal: c.stepIndex,
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

export type CodeWatchTarget = { path: string; recursive: boolean };

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
function codeWatchTarget(entry: string | undefined = Bun.main): CodeWatchTarget | undefined {
  if (entry !== undefined && isRuntimeScriptEntry(entry)) {
    return { path: dirname(entry), recursive: true };
  }
  return undefined;
}

/**
 * A workbench must not outlive the code it was built from: a stale server keeps answering
 * authenticated probes, so picker actions adopt it and serve the previous build. Returns a
 * disposer; an unwatchable target is not fatal, since termination signals still stop the process.
 */
export function retireOnCodeChange(
  onRetire: () => void,
  target: CodeWatchTarget | undefined = codeWatchTarget(),
): () => void {
  if (!target) return () => undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(target.path, { recursive: target.recursive }, (_event, file) => {
      if (target.recursive && !SERVED_SOURCE_RE.test(String(file ?? ""))) return;
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
      if (/^\[\d+\/\d+\]/.test(trimmed)) {
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
      ...(step.action.kind === "herdr" ? { method: step.action.method } : {}),
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
    if (!outcome.ok) {
      opts.onProgress?.(n, total, label, "fail");
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
    const progress = outcome.launched === true ? "launch" : "ok";
    opts.onProgress?.(n, total, label, progress);
    const kind: RunStepOutcomeKind = outcome.launched === true ? "launched" : "succeeded";
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
    outcome.ok
      ? outcome.launched === true
        ? "launched"
        : "succeeded"
      : outcome.coordinationLost
        ? "interrupted"
        : "failed",
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
  const dir = runScratchDir(repoRoot);
  await ensureLocalConfigGitignored(repoRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
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
  onProgress?: (step: number, total: number, label: string, outcome?: string) => void;
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
