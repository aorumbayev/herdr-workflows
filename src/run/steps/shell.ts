import type { FlatStep, PlaceholderValues } from "../../workflow/types";
import { substitute } from "../../workflow/parse";
import { placeCommand, type PlaceOpts } from "../place";

export const SHELL_TIMEOUT_MS = 300_000;

export type ShellName = "sh" | "bash" | "zsh" | "pwsh" | "powershell" | "cmd";

/** Single choke point for running a command string through an interpreter. */
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

export async function spawnCapture(
  argv: string[],
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
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
  });
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { timedOut, exitCode: exitCode ?? 1, stdout, stderr, timeoutMs };
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
    await spawnCapture(shellArgv(command, opts.shell ?? "sh"), {
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

export function substituteEnv(
  env: Record<string, string> | undefined,
  values: PlaceholderValues,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, substitute(v, values)]));
}

export function mapOut(
  out: FlatStep["out"],
  result: Record<string, unknown>,
): { ok: true; bindings?: Record<string, string> } | { ok: false; error: string } {
  if (out?.kind !== "map") return { ok: true };
  const bindings: Record<string, string> = {};
  for (const [name, path] of Object.entries(out.fields)) {
    let cur: unknown = result;
    for (const part of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === undefined) {
      const type = typeof result.type === "string" ? result.type : "unknown";
      return { ok: false, error: `out.${name}: path '${path}' missing on result.type '${type}'` };
    }
    bindings[name] = typeof cur === "string" ? cur : JSON.stringify(cur);
  }
  return { ok: true, bindings };
}

type ShellStepCtx = {
  step: FlatStep;
  values: PlaceholderValues;
  env: NodeJS.ProcessEnv;
  opts: PlaceOpts & {
    ctx: PlaceOpts["ctx"] & { cwd: string };
    deps: PlaceOpts["deps"] & {
      runArgv: typeof runArgvStep;
      runShell: typeof runShellStep;
      waitOutput: (paneId: string, pattern: string, timeoutMs: number) => Promise<unknown>;
    };
    onStderr?: (text: string) => void;
  };
};

export async function shellStep(
  c: ShellStepCtx,
): Promise<{ ok: true; bindings?: Record<string, string> } | { ok: false; error: string }> {
  const step = c.step as FlatStep & { action: { kind: "run" } };
  const cwd =
    step.action.cwd !== undefined ? substitute(step.action.cwd, c.values) : c.opts.ctx.cwd;
  const stepEnv = substituteEnv(step.action.env, c.values);
  const mergedEnv = { ...c.env, ...stepEnv };

  if (step.action.in === "here") {
    const payload = step.action.payload;
    const result =
      payload.form === "argv"
        ? await c.opts.deps.runArgv(
            payload.argv.map((el) => substitute(el, c.values)),
            { cwd, env: mergedEnv, timeoutMs: step.timeoutMs },
          )
        : await c.opts.deps.runShell(payload.command, {
            cwd,
            env: mergedEnv,
            timeoutMs: step.timeoutMs,
            shell: payload.shell,
          });
    if (result.stderr) c.opts.onStderr?.(result.stderr);
    if (!result.ok) return { ok: false, error: result.stderr.trim() || "nonzero exit" };
    const bindings: Record<string, string> = {};
    if (step.out?.kind === "text") bindings[step.out.name] = result.stdout;
    return { ok: true, bindings };
  }

  const label =
    step.name ??
    (step.action.payload.form === "argv"
      ? step.action.payload.argv[0] || "run"
      : step.action.payload.command.split(/\s+/)[0] || "run");
  const payload = step.action.payload;
  const argv =
    payload.form === "argv"
      ? payload.argv.map((el) => substitute(el, c.values))
      : shellArgv(payload.command, payload.shell);
  const placed = await placeCommand(
    c.opts,
    step.action.in,
    argv,
    label,
    cwd,
    stepEnv,
    step.action.ratio,
  );

  if (step.wait.kind === "detach") return { ok: true };
  if (step.wait.kind === "regex") {
    await c.opts.deps.waitOutput(placed.paneId, step.wait.pattern, step.timeoutMs ?? 60_000);
  }

  return mapOut(step.out, {
    tab_id: placed.tabId,
    pane_id: placed.paneId,
    workspace_id: placed.workspaceId,
    type: "layout",
    layout: {
      tab_id: placed.tabId,
      focused_pane_id: placed.paneId,
      workspace_id: placed.workspaceId,
    },
  });
}
