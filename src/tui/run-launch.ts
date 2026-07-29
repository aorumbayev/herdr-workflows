import { closeSync, mkdirSync, openSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { pluginStateDir, type InvocationContext } from "../config";

type DetachedRunResult = { ok: boolean; detail: string };

export type DetachedRunHandle = {
  result: Promise<DetachedRunResult>;
  detach: () => void;
};

/** Secrets for a detached `hwf run` — sent on stdin, never on argv. */
export type LaunchPayload = {
  name: string;
  inputs: Record<string, string>;
  /** Resolved dynamic choice domains keyed by input name. */
  domains?: Record<string, string[]>;
};

export type LaunchRunRequest = {
  name: string;
  repoRoot: string;
  ctx: InvocationContext;
  inputs: Record<string, string>;
  domains?: Record<string, string[]>;
  onProgressLine: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof Bun.spawn;
};

/** Env the detached `hwf run` child must inherit so context.* stays the caller's. */
export function buildInvocationEnv(
  ctx: InvocationContext,
  repoRoot: string,
): Record<string, string> {
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
export function isRuntimeScriptEntry(entry: string | undefined): boolean {
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
 * What an owned workbench watches to learn its own code changed. A compiled install watches its
 * executable — a plugin upgrade renames the managed checkout out from under it. A script entry
 * means the executable is only the runtime, so the entry's source tree is the build instead.
 */
export function codeWatchTarget(
  entry: string | undefined = Bun.main,
  execPath: string = process.execPath,
): CodeWatchTarget {
  if (entry !== undefined && isRuntimeScriptEntry(entry)) {
    return { path: dirname(entry), recursive: true };
  }
  return { path: execPath, recursive: false };
}

/**
 * A workbench must not outlive the code it was built from: a stale server keeps answering
 * authenticated probes, so picker actions adopt it and serve the previous build. Returns a
 * disposer; an unwatchable target is not fatal, since termination signals still stop the process.
 */
export function retireOnCodeChange(
  onRetire: () => void,
  target: CodeWatchTarget = codeWatchTarget(),
): () => void {
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

function selfCommandArgv(
  command: string,
  commandArgs: string[],
  opts?: { execPath?: string; argv1?: string },
): string[] {
  const execPath = opts?.execPath ?? process.execPath;
  const entry = opts?.argv1 ?? process.argv[1];
  if (entry !== undefined && isRuntimeScriptEntry(entry)) {
    return [execPath, entry, command, ...commandArgs];
  }
  return [execPath, command, ...commandArgs];
}

export function selfRunArgv(
  runArgs: string[],
  opts?: { execPath?: string; argv1?: string },
): string[] {
  return selfCommandArgv("run", runArgs, opts);
}

export function selfWebArgv(
  webArgs: string[],
  opts?: { execPath?: string; argv1?: string },
): string[] {
  return selfCommandArgv("web", webArgs, opts);
}

/** Argv after `run` — workflow name + flag only; inputs travel on stdin. */
export function buildRunArgs(name: string): string[] {
  return [name, "--launch-payload"];
}

export function buildLaunchPayload(
  name: string,
  inputs: Record<string, string>,
  domains?: Record<string, string[]>,
): LaunchPayload {
  return {
    name,
    inputs,
    ...(domains !== undefined && Object.keys(domains).length > 0 ? { domains } : {}),
  };
}

export function parseLaunchPayload(text: string): LaunchPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("launch payload is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("launch payload must be a JSON object");
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name) {
    throw new Error("launch payload requires a string name");
  }
  const inputs: Record<string, string> = {};
  if (row.inputs !== undefined) {
    if (row.inputs === null || typeof row.inputs !== "object" || Array.isArray(row.inputs)) {
      throw new Error("launch payload inputs must be an object");
    }
    for (const [key, value] of Object.entries(row.inputs as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new Error(`launch payload inputs.${key} must be a string`);
      }
      inputs[key] = value;
    }
  }
  let domains: Record<string, string[]> | undefined;
  if (row.domains !== undefined) {
    if (row.domains === null || typeof row.domains !== "object" || Array.isArray(row.domains)) {
      throw new Error("launch payload domains must be an object");
    }
    domains = {};
    for (const [key, value] of Object.entries(row.domains as Record<string, unknown>)) {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`launch payload domains.${key} must be a string array`);
      }
      domains[key] = value as string[];
    }
  }
  return { name: row.name, inputs, ...(domains !== undefined ? { domains } : {}) };
}

function decodeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<string> {
  if (!stream) return Promise.resolve("");
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let all = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      all += chunk;
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) onLine(buf);
    return all;
  })();
}

/** Spawn `hwf run` in its own process group so the picker popup can exit freely. */
export function launchDetachedRun(req: LaunchRunRequest): DetachedRunHandle {
  const spawn = req.spawn ?? Bun.spawn.bind(Bun);
  const argv = selfRunArgv(buildRunArgs(req.name));
  const payload = JSON.stringify(buildLaunchPayload(req.name, req.inputs, req.domains));
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
    const onLine = (line: string) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      if (/^\[\d+\/\d+\]/.test(trimmed)) {
        lastProgress = trimmed;
        if (!detached) req.onProgressLine(trimmed);
      }
    };
    const [stdoutText, stderrText, code] = await Promise.all([
      decodeLines(proc.stdout, onLine),
      decodeLines(proc.stderr, () => undefined),
      proc.exited,
    ]);
    if (detached) return;
    if (code === 0) {
      settle?.({ ok: true, detail: "" });
      settle = undefined;
      return;
    }
    const detail =
      stderrText.trim().split("\n").at(-1)?.trim() ||
      stdoutText.trim().split("\n").at(-1)?.trim() ||
      lastProgress ||
      `run exited ${code}`;
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
export function buildWebLaunchEnv(
  repoRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    HERDR_WORKFLOWS_REPO_ROOT: repoRoot,
  };
}

/** Append-only log for detached `hwf web` stderr (picker dismisses before the child settles). */
export function webLaunchStderrPath(stateDir: string = pluginStateDir()): string {
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
  const argv = selfWebArgv([req.route]);
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
export function openWebLaunchStderr(stateDir: string): number | "ignore" {
  try {
    mkdirSync(stateDir, { recursive: true });
    return openSync(webLaunchStderrPath(stateDir), "a");
  } catch {
    return "ignore";
  }
}
