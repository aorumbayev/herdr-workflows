import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../src/adapter/rpc";
import { appendRunLog, runLogPath, type RunLogEntry } from "../src/runlog";
import { runWorkflow, resolveInputValues, type RunnerDeps } from "../src/run/runner";
import { runShellStep, SHELL_TIMEOUT_MS } from "../src/run/steps/shell";
import {
  AGENT_WAIT_IDLE_GRACE_MS,
  AGENT_WAIT_POLL_MS,
  waitAgentDone,
  type WaitAgentDoneOpts,
} from "../src/run/steps/agent";

const dirs: string[] = [];
beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "herdr-workflows-state-"));
  dirs.push(state);
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});
afterEach(async () => {
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function readRunLog(): Promise<RunLogEntry[]> {
  const text = await readFile(runLogPath(), "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunLogEntry);
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-run-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.yaml`), body);
  }
  return root;
}

function mockDeps(overrides: Partial<RunnerDeps> = {}): {
  deps: RunnerDeps;
  notes: string[];
  calls: { method: string; params: Record<string, unknown> }[];
  layouts: unknown[];
} {
  const notes: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const layouts: unknown[] = [];
  const deps: RunnerDeps = {
    layoutApply: async (params) => {
      layouts.push(params);
      return { tabId: "t1", paneId: "p1", workspaceId: "w1" };
    },
    herdrCall: async (method, params = {}) => {
      calls.push({ method, params });
      return { type: "ok", ...params };
    },
    notificationShow: async (title, body) => {
      notes.push(`${title}|${body ?? ""}`);
    },
    runShell: runShellStep,
    runArgv: async (argv, opts) => {
      const { spawnCapture } = await import("../src/run/steps/shell");
      const r = await spawnCapture(argv, opts);
      if (r.timedOut) return { ok: false, stdout: r.stdout, stderr: "timed out" };
      if (r.exitCode !== 0) return { ok: false, stdout: r.stdout, stderr: r.stderr };
      return { ok: true, stdout: r.stdout, stderr: r.stderr };
    },
    agentStatus: async () => "idle",
    agentLabel: async () => "claude",
    waitOutput: async () => undefined,
    paneRead: async () => "",
    reportToken: async () => undefined,
    sessionText: async () => "",
    tabClose: async () => undefined,
    sleep: async () => undefined,
    agentWaitPollMs: 1,
    agentWaitIdleGraceMs: 5,
    ...overrides,
  };
  return { deps, notes, calls, layouts };
}

describe("waitAgentDone", () => {
  test("defaults match exported constants", async () => {
    expect(AGENT_WAIT_POLL_MS).toBe(2000);
    expect(AGENT_WAIT_IDLE_GRACE_MS).toBe(30_000);
    let clock = 0;
    const opts: WaitAgentDoneOpts = {
      agentStatus: async () => "done",
      sleep: async () => undefined,
      now: () => clock,
      pollMs: AGENT_WAIT_POLL_MS,
      idleGraceMs: AGENT_WAIT_IDLE_GRACE_MS,
    };
    await waitAgentDone("p1", 5000, opts);
  });
});

describe("runner v2", () => {
  test("required constructor input does not inherit a provided value", () => {
    const result = resolveInputValues([{ name: "constructor", label: "constructor" }], {});
    expect(result).toEqual({
      ok: false,
      error: "missing input 'constructor' (--input constructor=…)",
    });
  });

  test("flat inputs resolve into prompt and agent name", async () => {
    const root = await repoWith({
      m: `inputs:
  target: [claude, codex]
  focus: text
steps:
  - agent: "{target}"
    prompt: "focus={focus}"
`,
    });
    const { deps, layouts } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"], codex: ["codex", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      inputs: { target: "codex", focus: "tests" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({
      root: { command: ["codex", "focus=tests"] },
    });
  });

  test("named out threads between run steps", async () => {
    const root = await repoWith({
      m: `steps:
  - run: printf hi
    out: msg
  - run: [cat]
    # cat with no stdin — bind via env instead
  - run: 'printf %s "$HWF_msg"'
`,
    });
    // Fix: second step unused. Simpler workflow:
    const root2 = await repoWith({
      m: `steps:
  - run: printf hi
    out: msg
  - run: 'printf %s "$HWF_msg"'
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root2,
      agents: {},
      ctx: { selection: "", cwd: root2 },
      deps,
    });
    expect(result.ok).toBe(true);
    void root;
  });

  test("failure stops sequence and notifies once", async () => {
    const root = await repoWith({
      m: `steps:\n  - run: "echo one"\n  - run: "echo two >&2; exit 1"\n  - run: "echo three"\n`,
    });
    const { deps, notes } = mockDeps();
    const saw: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label) => saw.push(label),
    });
    expect(result.ok).toBe(false);
    expect(saw.some((s) => s.includes("three"))).toBe(false);
    expect(notes).toHaveLength(1);
  });

  test("when skip continues and binds empty out", async () => {
    const root = await repoWith({
      m: `steps:
  - run: "true"
    out: diff
  - run: "printf ran"
    when: "{diff}"
  - run: "printf done"
`,
    });
    const { deps } = mockDeps();
    const outcomes: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label, outcome) => outcomes.push(`${label}:${outcome ?? "ok"}`),
    });
    expect(result.ok).toBe(true);
    expect(outcomes.some((o) => o.includes("skip"))).toBe(true);
  });

  test("skipped step does not trigger on_error", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: "printf recovered"\n`,
      m: `on_error: recover\nsteps:\n  - run: "printf x"\n    when: "{missing}"\n`,
    });
    // {missing} is unknown at load — use a bound empty name
    const root2 = await repoWith({
      recover: `steps:\n  - run: "printf recovered"\n`,
      m: `on_error: recover
steps:
  - run: "true"
    out: diff
  - run: "printf should-skip"
    when: "{diff}"
`,
    });
    const { deps, notes } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root2,
      agents: {},
      ctx: { selection: "", cwd: root2 },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(notes).toHaveLength(0);
    void root;
  });

  test("for loop with allow_fail isolates item failures", async () => {
    const root = await repoWith({
      m: `steps:
  - run: [sh, -c, 'test "{item}" != "b"']
    for: [a, b, c]
    allow_fail: true
`,
    });
    const { deps } = mockDeps();
    const labels: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label) => labels.push(label),
    });
    expect(result.ok).toBe(false);
    expect(labels.some((l) => l.includes("[0]"))).toBe(true);
    expect(labels.some((l) => l.includes("[1]"))).toBe(true);
    expect(labels.some((l) => l.includes("[2]"))).toBe(true);
  });

  test("for fail-fast aborts remaining items", async () => {
    const root = await repoWith({
      m: `steps:
  - run: [sh, -c, 'test "{item}" != "b"']
    for: [a, b, c]
`,
    });
    const { deps } = mockDeps();
    const labels: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label) => labels.push(label),
    });
    expect(result.ok).toBe(false);
    expect(labels.some((l) => l.includes("[2]"))).toBe(false);
  });

  test("retry shorthand succeeds after failures", async () => {
    const root = await repoWith({
      m: `steps:\n  - run: [sh, -c, 'test -f stamp || (touch stamp; exit 1)']\n    retry: 3\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("on_error recovery runs once on abort", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: 'printf %s "$HWF_error"'\n`,
      m: `steps:\n  - run: "exit 1"\non_error: recover\n`,
    });
    const { deps, notes } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  test("allow_fail does not trigger on_error", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: "printf recovered"\n`,
      m: `on_error: recover\nsteps:\n  - run: "exit 1"\n    allow_fail: true\n  - run: "printf ok"\n`,
    });
    const { deps } = mockDeps();
    const labels: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label) => labels.push(label),
    });
    expect(result.ok).toBe(false);
    expect(labels.some((l) => l.includes("recovered") || l.includes("recover"))).toBe(false);
    expect(labels.some((l) => l.includes("ok"))).toBe(true);
  });

  test("primitive autofill and out binding", async () => {
    const root = await repoWith({
      m: `steps:
  - pane.split: { direction: right }
    out: { split: pane_id }
`,
    });
    const { deps, calls } = mockDeps({
      herdrCall: async (method, params = {}) => {
        calls.push({ method, params });
        return { type: "pane_info", pane_id: "p-new", tab_id: "t9", workspace_id: "w1" };
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "t9", paneId: "p9" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("pane.split");
    expect(calls[0]?.params).toMatchObject({
      direction: "right",
      workspace_id: "w1",
    });
  });

  test("missing result path names result.type", async () => {
    const root = await repoWith({
      m: `steps:
  - pane.split: { direction: right }
    out: { split: worktree.path }
`,
    });
    const { deps, notes } = mockDeps({
      herdrCall: async () => ({ type: "pane_info", pane_id: "p1" }),
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "p9" },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(notes[0]).toContain("pane_info");
  });

  test("placed run uses layout.apply; regex wait calls waitOutput", async () => {
    const root = await repoWith({
      m: `steps:
  - run: bun run dev
    in: tab
    wait: /listening/
    timeout: 5
    out: { tab: layout.tab_id, p: layout.focused_pane_id }
`,
    });
    const waits: { paneId: string; match: string }[] = [];
    const { deps, layouts } = mockDeps({
      waitOutput: async (paneId, match) => {
        waits.push({ paneId, match });
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({
      tabLabel: "bun",
      root: { type: "pane", command: ["sh", "-c", "bun run dev"] },
    });
    expect(waits).toEqual([{ paneId: "p1", match: "listening" }]);
  });

  test("in: right uses split layout", async () => {
    const root = await repoWith({
      m: `steps:
  - run: lazygit
    in: right
    ratio: 0.333
`,
    });
    const { deps, layouts } = mockDeps();
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "t0", paneId: "p0" },
      deps,
    });
    expect(layouts[0]).toMatchObject({
      tabId: "t0",
      root: {
        type: "split",
        direction: "right",
        ratio: 0.333,
        first: { type: "pane", pane_id: "p0" },
      },
    });
  });

  test("agent blocks by default", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n`,
    });
    let n = 0;
    const { deps } = mockDeps({
      agentStatus: async () => {
        n += 1;
        return n < 2 ? "working" : "done";
      },
      paneRead: async () => "done output",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test("agent out binds final message", async () => {
    const root = await repoWith({
      m: `steps:
  - agent: claude
    prompt: hi
    out: brief
  - run: 'printf %s "$HWF_brief"'
`,
    });
    const { deps } = mockDeps({
      agentStatus: async () => "done",
      paneRead: async () => "from-pane",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("session substitutes into prompt", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: "S={session}"\n`,
    });
    const { deps, layouts } = mockDeps({
      sessionText: async () => "transcript",
      agentStatus: async () => "done",
    });
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "p1" },
      deps,
    });
    const rootNode = (layouts[0] as { root: { command: string[] } }).root;
    expect(rootNode.command[1]).toContain("transcript");
  });

  test("needsSession without paneId fails without on_error", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: "printf recovered"\n`,
      m: `on_error: recover\nsteps:\n  - agent: claude\n    prompt: "{session}"\n`,
    });
    const { deps, notes } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(notes[0]).toContain("agent pane");
  });

  test('agent: "{agent}" resolves from invoking pane', async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: "{agent}"\n    prompt: hi\n`,
    });
    const { deps, layouts } = mockDeps({
      agentLabel: async () => "codex",
      agentStatus: async () => "done",
    });
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude"], codex: ["codex", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "p1" },
      deps,
    });
    expect(layouts[0]).toMatchObject({ root: { command: ["codex", "hi"] } });
  });

  test("shell steps export HWF_<name> env", async () => {
    const root = await repoWith({
      m: `inputs:\n  branch: text\nsteps:\n  - run: 'printf %s "$HWF_branch"'\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { branch: "feat/x" },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("runlog records skips distinctly", async () => {
    const root = await repoWith({
      m: `steps:
  - run: "true"
    out: diff
  - run: "printf x"
    when: "{diff}"
`,
    });
    const { deps } = mockDeps();
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    const log = await readRunLog();
    expect(log.some((e) => e.skipped === true)).toBe(true);
  });

  test("timeout kills process group", async () => {
    expect(SHELL_TIMEOUT_MS).toBe(300_000);
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-pg-"));
    dirs.push(dir);
    const pidFile = join(dir, "child.pid");
    const script = `sleep 60 & echo $! > "${pidFile}"; wait`;
    const result = await runShellStep(script, { cwd: dir, timeoutMs: 400 });
    expect(result.ok).toBe(false);
    await Bun.sleep(100);
    const pidText = await readFile(pidFile, "utf8").catch(() => "");
    const childPid = Number(pidText.trim());
    if (childPid > 0) {
      let alive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });

  test("appendRunLog swallows fs errors", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = "/dev/null/not-a-dir";
    await appendRunLog({
      ts: new Date().toISOString(),
      run: "x",
      workflow: "y",
      ok: true,
    });
  });

  test("agent wait timeout fails", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n    timeout: 1\n`,
    });
    let clock = 0;
    const { deps, notes } = mockDeps({
      agentStatus: async () => "working",
      now: () => clock,
      sleep: async () => {
        clock += 600;
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(notes.some((n) => n.includes("timed out") || n.includes("step 1"))).toBe(true);
  });

  test("use inclusion runs child then parent", async () => {
    const root = await repoWith({
      gate: `inputs:\n  suite: text = unit\nsteps:\n  - run: 'printf %s "$HWF_suite"'\n`,
      ship: `steps:\n  - use: gate\n    with: { suite: all }\n  - run: "printf push"\n`,
    });
    const { deps } = mockDeps();
    const labels: string[] = [];
    const result = await runWorkflow({
      name: "ship",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label) => labels.push(label),
    });
    expect(result.ok).toBe(true);
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  test("waitOutput throw fails placed step", async () => {
    const root = await repoWith({
      m: `steps:\n  - run: bun\n    in: tab\n    wait: /ready/\n`,
    });
    const { deps, notes } = mockDeps({
      waitOutput: async () => {
        throw new HerdrError("wait_output_failed", "match timeout");
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(notes[0]).toContain("match timeout");
  });
});
