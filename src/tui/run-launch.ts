import type { InvocationContext } from "../config";

type DetachedRunResult = { ok: boolean; detail: string };

export type DetachedRunHandle = {
  result: Promise<DetachedRunResult>;
  detach: () => void;
};

export type LaunchRunRequest = {
  name: string;
  repoRoot: string;
  ctx: InvocationContext;
  inputs: Record<string, string>;
  prompt: string;
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

export function selfRunArgv(runArgs: string[]): string[] {
  const entry = process.argv[1];
  if (typeof entry === "string" && /\.(ts|js|mjs|cjs)$/.test(entry)) {
    return [process.execPath, entry, "run", ...runArgs];
  }
  return [process.execPath, "run", ...runArgs];
}

export function buildRunArgs(
  name: string,
  inputs: Record<string, string>,
  prompt: string,
): string[] {
  const args = [name];
  for (const [key, value] of Object.entries(inputs)) {
    args.push("--input", `${key}=${value}`);
  }
  if (prompt) args.push("--prompt", prompt);
  return args;
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
  const argv = selfRunArgv(buildRunArgs(req.name, req.inputs, req.prompt));
  const env = {
    ...process.env,
    ...req.env,
    ...buildInvocationEnv(req.ctx, req.repoRoot),
  };
  const proc = spawn(argv, {
    cwd: req.repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    proc.unref();
  };

  const result = (async (): Promise<DetachedRunResult> => {
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
    if (code === 0) return { ok: true, detail: "" };
    const detail =
      stderrText.trim().split("\n").at(-1)?.trim() ||
      stdoutText.trim().split("\n").at(-1)?.trim() ||
      lastProgress ||
      `run exited ${code}`;
    return { ok: false, detail };
  })();

  return { result, detach };
}
