import { CAPTURE_BYTE_LIMIT, CaptureLimitError } from "../caps";
import { validateHerdrInvocation } from "../host";
import { renderScalar, substituteParams, substituteText } from "../workflow/grammar";
import type { PaneOpen, ShellName, StepAction, TemplateNamespace } from "../workflow/grammar";
import type { CommandResult, StepFailureDetails } from "../workflow/results";
import {
  dispatchFailure,
  errorText,
  readTruncated,
  type StepFrame,
  type StepOutcome,
} from "./contract";
import { placeCommandPane, resolvePaneOpen } from "./pane";

export async function herdrStep(frame: StepFrame): Promise<StepOutcome> {
  const action = frame.step.action;
  if (action.kind !== "herdr") return { ok: false, error: "internal: not a herdr step" };
  const params = substituteParams(action.params, frame.values) ?? {};
  const invalid = validateHerdrInvocation(action.method, params);
  if (invalid) return { ok: false, error: invalid, details: { method: action.method } };
  try {
    const result = await frame.opts.deps.herdrCall(action.method, params);
    return { ok: true, result, ...(readTruncated(result) ? { truncated: true } : {}) };
  } catch (error) {
    const failure = dispatchFailure(`herdr ${action.method}`, error);
    return failure.ok ? failure : { ...failure, details: { method: action.method } };
  }
}

type CommandAction = Extract<StepAction, { kind: "run" }>;

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

function commandArgv(action: CommandAction, ns: TemplateNamespace): string[] {
  const payload = action.payload;
  if (payload.form === "argv") return payload.argv.map((el) => substituteText(el, ns));
  return shellArgv(payload.command, payload.shell);
}

function bindCommandResult(frame: StepFrame, outcome: CommandOutcome): void {
  if (!frame.step.id) return;
  const result: CommandResult = {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.exitCode,
    failed: outcome.failed,
  };
  frame.values.steps[frame.step.id] = result;
}

function commandFailure(outcome: CommandOutcome): Extract<StepOutcome, { ok: false }> {
  const detail = outcome.stderr.trim() || outcome.stdout.trim().slice(-500);
  const details: StepFailureDetails = {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.exitCode,
  };
  return {
    ok: false,
    error: detail || `exit ${outcome.exitCode}`,
    details,
  };
}

async function localCommand(
  frame: StepFrame,
  action: CommandAction,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<StepOutcome> {
  const payload = action.payload;
  const successCodes = action.successCodes ?? [0];
  let outcome: CommandOutcome;
  try {
    outcome =
      payload.form === "argv"
        ? await runArgvStep(commandArgv(action, frame.values), {
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
  if (outcome.stderr) frame.opts.onStderr?.(outcome.stderr);
  if (outcome.timedOut) return { ...commandFailure(outcome), hardFailure: true };
  bindCommandResult(frame, outcome);
  return outcome.failed ? commandFailure(outcome) : { ok: true };
}

const READY_LINES = 80;

async function placedCommand(
  frame: StepFrame,
  action: CommandAction,
  cwd: string,
  paneEnv: Record<string, string>,
): Promise<StepOutcome> {
  const pane = action.pane;
  if (!pane) return { ok: false, error: "run: background and ready_when require pane:" };
  const sub = (text?: string) =>
    text === undefined ? undefined : substituteText(text, frame.values);
  let open: PaneOpen;
  try {
    open = resolvePaneOpen(pane.open, frame.values);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  const placed = await placeCommandPane({
    open,
    anchor: sub(pane.anchor),
    workspace: sub(pane.workspace),
    size: pane.size,
    focus: pane.focus ?? action.background !== true,
    cwd,
    env: paneEnv,
    label: sub(pane.name) ?? frame.step.id ?? "hwf-run",
    argv: commandArgv(action, frame.values),
    deps: frame.opts.deps,
    invocation: frame.opts.ctx,
  });
  if (action.background === true) return { ok: true, launched: true };
  if (action.readyWhen === undefined || action.timeoutMs === undefined) {
    return { ok: false, error: "run: placed foreground run requires ready_when and timeout" };
  }
  const waited = await frame.opts.deps.herdrCall("pane.wait_for_output", {
    pane_id: placed.pane_id,
    source: "recent",
    lines: READY_LINES,
    strip_ansi: true,
    match: { type: "regex", value: action.readyWhen },
    timeout_ms: action.timeoutMs,
  });
  return {
    ok: true,
    result: { ...waited, ...placed },
    ...(readTruncated(waited) ? { truncated: true } : {}),
  };
}

export async function shellStep(
  frame: StepFrame & { env: NodeJS.ProcessEnv },
): Promise<StepOutcome> {
  const action = frame.step.action;
  if (action.kind !== "run") return { ok: false, error: "internal: not a run step" };
  const stepEnv = stepEnvValues(action.env, frame.values);
  if (!stepEnv.ok) return { ok: false, error: stepEnv.error };
  const hwf = buildHwfEnv(frame.values.inputs);
  const cwd =
    action.cwd !== undefined ? substituteText(action.cwd, frame.values) : frame.opts.ctx.cwd;
  if (action.pane || action.background === true || action.readyWhen !== undefined) {
    try {
      return await placedCommand(frame, action, cwd, { ...hwf, ...stepEnv.env });
    } catch (error) {
      return dispatchFailure("run", error);
    }
  }
  return localCommand(frame, action, cwd, mergeStepEnv(frame.env, hwf, stepEnv.env));
}
