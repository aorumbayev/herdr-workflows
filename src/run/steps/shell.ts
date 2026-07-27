import { CaptureLimitError, CAPTURE_BYTE_LIMIT } from "../../limits";
import type { ShellName, TemplateNamespace, WorkflowStep } from "../../workflow/types";
import { substituteText } from "../../workflow/parse";

const SHELL_TIMEOUT_MS = 300_000;

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

export type { ShellName };

export function defaultShell(platform: string = process.platform): ShellName {
  return platform === "win32" ? "cmd" : "sh";
}

export function shellArgv(command: string, shell: ShellName = defaultShell()): string[] {
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

export function killSpawn(
  proc: { pid: number; kill: () => void },
  platform: string = process.platform,
): void {
  if (platform === "win32") {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
    return;
  }
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

export async function spawnCapture(
  argv: string[],
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxCaptureBytes?: { source: string; limit?: number };
  },
): Promise<{
  timedOut: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timeoutMs: number;
}> {
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    detached: true,
    windowsHide: true,
  });
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killSpawn(proc);
  }, timeoutMs);

  const budget = opts.maxCaptureBytes
    ? {
        source: opts.maxCaptureBytes.source,
        limit: opts.maxCaptureBytes.limit ?? CAPTURE_BYTE_LIMIT,
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

function captureResult(r: {
  timedOut: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timeoutMs: number;
}): { ok: boolean; stdout: string; stderr: string } {
  if (r.timedOut) {
    return {
      ok: false,
      stdout: r.stdout,
      stderr: r.stderr || `timed out after ${r.timeoutMs / 1000}s`,
    };
  }
  if (r.exitCode !== 0) return { ok: false, stdout: r.stdout, stderr: r.stderr };
  return { ok: true, stdout: r.stdout, stderr: r.stderr };
}

export async function runShellStep(
  command: string,
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: ShellName;
  },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return captureResult(
    await spawnCapture(shellArgv(command, opts.shell), {
      cwd: opts.cwd,
      stdin: opts.stdin,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    }),
  );
}

export async function runArgvStep(
  argv: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return captureResult(
    await spawnCapture(argv, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    }),
  );
}

function substituteEnv(
  env: Record<string, string> | undefined,
  ns: TemplateNamespace,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, substituteText(v, ns)]));
}

export async function shellStep(c: {
  step: WorkflowStep;
  values: TemplateNamespace;
  env?: NodeJS.ProcessEnv;
  opts?: {
    ctx: { cwd: string };
    deps: {
      runArgv: typeof runArgvStep;
      runShell: typeof runShellStep;
    };
    onStderr?: (text: string) => void;
  };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const action = c.step.action;
  if (action.kind !== "run") return { ok: false, error: "internal: not a run step" };
  if (action.pane || action.background || action.readyWhen) {
    return { ok: false, error: "v1alpha1 placed run execution is not implemented yet" };
  }
  if (!c.opts) return { ok: false, error: "v1alpha1 run execution is not implemented yet" };
  const cwd = action.cwd !== undefined ? substituteText(action.cwd, c.values) : c.opts.ctx.cwd;
  const stepEnv = substituteEnv(action.env, c.values);
  const mergedEnv = { ...c.env, ...stepEnv };
  const payload = action.payload;
  const result =
    payload.form === "argv"
      ? await c.opts.deps.runArgv(
          payload.argv.map((el) => substituteText(el, c.values)),
          { cwd, env: mergedEnv, timeoutMs: action.timeoutMs },
        )
      : await c.opts.deps.runShell(payload.command, {
          cwd,
          env: mergedEnv,
          timeoutMs: action.timeoutMs,
          shell: payload.shell,
        });
  if (result.stderr) c.opts.onStderr?.(result.stderr);
  if (!result.ok) return { ok: false, error: result.stderr.trim() || "nonzero exit" };
  return { ok: true };
}
