export const SHELL_TIMEOUT_MS = 300_000;

// Single choke point for "run a command string in the system shell" — the only
// place platform shell choice lives when Windows support lands (herdr win32 is beta-only).
export function shellArgv(command: string): string[] {
  return process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
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

export async function runShellStep(
  command: string,
  opts: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<
  { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string }
> {
  const { timedOut, exitCode, stdout, stderr, timeoutMs } = await spawnCapture(shellArgv(command), {
    cwd: opts.cwd,
    stdin: opts.stdin,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
  });
  if (timedOut) {
    return { ok: false, stdout, stderr: stderr || `timed out after ${timeoutMs / 1000}s` };
  }
  if (exitCode !== 0) return { ok: false, stdout, stderr };
  return { ok: true, stdout, stderr };
}
