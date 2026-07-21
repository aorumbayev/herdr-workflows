import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../src/adapter/client";
import { appendRunLog, runLogPath, type RunLogEntry } from "../src/runlog";
import type { RunnerDeps } from "../src/runner";
import { runWorkflow, runShellStep, SHELL_TIMEOUT_MS } from "../src/runner";
import { resolveInputValues } from "../src/runner/inputs";
import {
  AGENT_WAIT_IDLE_GRACE_MS,
  AGENT_WAIT_POLL_MS,
  waitAgentDone,
  type WaitAgentDoneOpts,
} from "../src/runner/agent-wait";

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
      return {};
    },
    notificationShow: async (title, body) => {
      notes.push(`${title}|${body ?? ""}`);
    },
    runShell: runShellStep,
    agentStatus: async () => "idle",
    agentLabel: async () => "claude",
    waitOutput: async () => undefined,
    paneRead: async () => "",
    reportToken: async () => undefined,
    sessionText: async () => "",
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

describe("runner", () => {
  test("required constructor input does not inherit a provided value", () => {
    const result = resolveInputValues([{ name: "constructor", label: "constructor" }], {});
    expect(result).toEqual({
      ok: false,
      error: "missing input 'constructor' (--input constructor=…)",
    });

    const resolved = resolveInputValues([{ name: "constructor", label: "constructor" }], {
      constructor: "value",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(Object.getPrototypeOf(resolved.values)).toBeNull();
  });

  test("inputs substitute into stdin and choice input resolves agent", async () => {
    const root = await repoWith({
      m: `inputs:
  target:
    options: [claude, codex]
  focus: {}
steps:
  - shell: cat
    stdin: "focus={input.focus}"
  - agent: "{input.target}"
    prompt: "{last}"
`,
    });
    const { deps, layouts } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"], codex: ["codex", "{prompt}"] },
      ctx: { selection: "", cwd: root },
      inputs: { target: "codex", focus: "tests" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ label: "codex", command: ["codex", "focus=tests"] });
  });

  test("missing required input fails before steps", async () => {
    const root = await repoWith({
      m: `inputs:\n  focus: {}\nsteps:\n  - shell: cat\n    stdin: "{input.focus}"\n`,
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
    expect(notes[0]).toContain("missing input 'focus'");
  });

  test("default fills missing input; bad choice value fails", async () => {
    const root = await repoWith({
      m: `inputs:\n  mode:\n    options: [fast, slow]\n    default: fast\nsteps:\n  - shell: cat\n    stdin: "{input.mode}"\n`,
    });
    const { deps } = mockDeps();
    const ok = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(ok.ok).toBe(true);

    const bad = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { mode: "warp" },
      deps,
    });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain("must be one of");
  });

  test("unknown provided input fails", async () => {
    const root = await repoWith({
      m: `inputs:\n  focus: {}\nsteps:\n  - shell: cat\n    stdin: "{input.focus}"\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { focus: "x", extra: "y" },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("unknown input 'extra'");
  });

  test("failure at step N stops sequence and notifies once", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: "echo one"\n  - shell: "echo two >&2; exit 1"\n  - shell: "echo three"\n`,
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
    expect(notes[0]).toContain("step 2");
  });

  test("{last} threads between shell steps", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: "printf hi"\n  - shell: "cat"\n    stdin: "{last}"\n`,
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
    if (result.ok) expect(result.last).toBe("hi");
  });

  test("timeout kills process group", async () => {
    expect(SHELL_TIMEOUT_MS).toBe(300_000);
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-pg-"));
    dirs.push(dir);
    const pidFile = join(dir, "child.pid");
    const script = `sleep 60 & echo $! > "${pidFile}"; wait`;
    const result = await runShellStep(script, { cwd: dir, timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/timed out|./);
    // wait briefly for kill to land
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

  test("recovery runs once; recovery failure notifies and stops", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: "cat"\n    stdin: "{error}"\n  - shell: "exit 1"\n`,
      m: `steps:\n  - shell: "printf kept"\n  - shell: "exit 1"\non_fail: recover\n`,
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
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("step 2");
    expect(notes[1]).toContain("step 2");
  });

  test("{error} filled only in recovery; {last} survives", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: "cat"\n    stdin: "L={last} E={error}"\n`,
      m: `steps:\n  - shell: "printf kept"\n  - shell: "exit 1"\non_fail: recover\n`,
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
    if (result.ok) {
      expect(result.last).toContain("L=kept");
      expect(result.last).toContain("E=step 2");
    }
  });

  test("herdr params auto-filled from context", async () => {
    const root = await repoWith({
      m: `steps:\n  - herdr: tab.close\n`,
    });
    const { deps, calls } = mockDeps();
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "t9", paneId: "p9" },
      deps,
    });
    expect(calls[0]?.method).toBe("tab.close");
    expect(calls[0]?.params).toEqual({ tab_id: "t9", pane_id: "p9", workspace_id: "w1" });
  });

  test("agent prompt passed as single argv element", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: "line1\\n$(rm -rf /)"\n`,
    });
    const { deps, layouts } = mockDeps();
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    const layout = layouts[0] as { command: string[] };
    expect(layout.command).toEqual(["claude", "line1\n$(rm -rf /)"]);
  });

  test("agent wait completes on explicit done", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n    wait: done\n    timeout: 5\n`,
    });
    let n = 0;
    const { deps } = mockDeps({
      agentStatus: async () => {
        n += 1;
        return n < 2 ? "working" : "done";
      },
      paneRead: async () => " done output \n",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toBe("done output");
  });

  test("agent wait completes on working→idle", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n`,
    });
    let n = 0;
    const { deps } = mockDeps({
      agentStatus: async () => {
        n += 1;
        return n < 2 ? "working" : "idle";
      },
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

  test("agent wait completes on never-working idle grace", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n`,
    });
    let clock = 0;
    const { deps } = mockDeps({
      agentStatus: async () => "idle",
      agentWaitIdleGraceMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 5;
      },
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

  test("agent blocked notifies once then completes", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n`,
    });
    const statuses = ["working", "blocked", "blocked", "working", "done"];
    let i = 0;
    const { deps, notes } = mockDeps({
      agentStatus: async () => statuses[Math.min(i++, statuses.length - 1)]!,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(notes.filter((n) => n.includes("waiting"))).toHaveLength(1);
    expect(notes[0]).toContain("agent blocked on step 1");
  });

  test("agent wait timeout fails and runs on_fail", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: "printf recovered"\n`,
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 1\non_fail: recover\n`,
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
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toBe("recovered");
    expect(notes.some((n) => n.includes("timed out"))).toBe(true);
  });

  test("agent wait success sets {last} for next step", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n  - shell: "cat"\n    stdin: "{last}"\n`,
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
    if (result.ok) expect(result.last).toBe("from-pane");
  });

  test("wait_for ok continues; throw fails step", async () => {
    const rootOk = await repoWith({
      m: `steps:\n  - open: bun run dev\n    wait_for: ready\n    timeout: 5\n  - shell: "printf next"\n`,
    });
    const waits: { paneId: string; match: string; timeoutMs: number }[] = [];
    const { deps } = mockDeps({
      waitOutput: async (paneId, match, timeoutMs) => {
        waits.push({ paneId, match, timeoutMs });
      },
    });
    const ok = await runWorkflow({
      name: "m",
      repoRoot: rootOk,
      agents: {},
      ctx: { selection: "", cwd: rootOk, workspaceId: "w1" },
      deps,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.last).toBe("next");
    expect(waits).toEqual([{ paneId: "p1", match: "ready", timeoutMs: 5000 }]);

    const rootBad = await repoWith({
      m: `steps:\n  - open: bun run dev\n    wait_for: ready\n    timeout: 5\n`,
    });
    const { deps: badDeps, notes } = mockDeps({
      waitOutput: async () => {
        throw new HerdrError("wait_output_failed", "match timeout");
      },
    });
    const bad = await runWorkflow({
      name: "m",
      repoRoot: rootBad,
      agents: {},
      ctx: { selection: "", cwd: rootBad, workspaceId: "w1" },
      deps: badDeps,
    });
    expect(bad.ok).toBe(false);
    expect(notes[0]).toContain("match timeout");
  });

  test("agentStatus errors before detection tolerated until grace, then fail", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n`,
    });
    let clock = 0;
    let n = 0;
    const { deps } = mockDeps({
      now: () => clock,
      agentStatus: async () => {
        n += 1;
        clock += 3; // grace is 5ms: elapsed 0, 3 tolerated; 6 exceeds
        throw new HerdrError("agent_status_failed", `err${n}`);
      },
    });
    const failed = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(failed.ok).toBe(false);
    expect(n).toBe(3);
  });

  test("after detection, 3 consecutive agentStatus errors fail; 2 then success continues", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    wait: done\n    timeout: 5\n`,
    });
    let n = 0;
    const { deps: failDeps } = mockDeps({
      now: () => 0,
      agentStatus: async () => {
        n += 1;
        if (n === 1) return "working";
        throw new HerdrError("agent_status_failed", `err${n}`);
      },
    });
    const failed = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps: failDeps,
    });
    expect(failed.ok).toBe(false);
    expect(n).toBe(4);

    let m = 0;
    const { deps: okDeps } = mockDeps({
      now: () => 0,
      agentStatus: async () => {
        m += 1;
        if (m <= 2) throw new HerdrError("agent_status_failed", `err${m}`);
        return "done";
      },
    });
    const ok = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps: okDeps,
    });
    expect(ok.ok).toBe(true);
    expect(m).toBe(3);
  });

  test("runlog: step entries + final; failure carries error", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: "printf one"\n  - shell: "echo boom >&2; exit 1"\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    const entries = await readRunLog();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      workflow: "m",
      step: 1,
      total: 2,
      label: "shell: printf one",
      ok: true,
    });
    expect(entries[1]).toMatchObject({
      workflow: "m",
      step: 2,
      total: 2,
      ok: false,
    });
    expect(entries[1]?.error).toContain("step 2");
    expect(entries[2]).toMatchObject({ workflow: "m", ok: false });
    expect(entries[2]?.step).toBeUndefined();
    expect(entries[2]?.error).toContain("step 2");
    const runIds = new Set(entries.map((e) => e.run));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]?.length).toBe(8);
  });

  test("appendRunLog swallows fs errors", async () => {
    const blocker = join(tmpdir(), `herdr-workflows-not-a-dir-${Date.now()}`);
    await writeFile(blocker, "file");
    dirs.push(blocker);
    process.env.HERDR_PLUGIN_STATE_DIR = blocker;
    await expect(
      appendRunLog({
        ts: new Date().toISOString(),
        run: "abcd1234",
        workflow: "m",
        ok: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("token: progress then clear when paneId set; skipped without", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: "printf a"\n  - shell: "printf b"\n`,
    });
    const tokens: (string | null)[] = [];
    const { deps } = mockDeps({
      reportToken: async (_paneId, value) => {
        tokens.push(value);
      },
    });
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "p9" },
      deps,
    });
    expect(tokens).toEqual(["m 1/2", "m 2/2", null]);

    const tokensNoPane: (string | null)[] = [];
    const { deps: depsNoPane } = mockDeps({
      reportToken: async (_paneId, value) => {
        tokensNoPane.push(value);
      },
    });
    await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps: depsNoPane,
    });
    expect(tokensNoPane).toEqual([]);
  });

  test("token: reportToken rejection does not fail the run", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: "printf ok"\n`,
    });
    const { deps } = mockDeps({
      reportToken: async () => {
        throw new HerdrError("report_token_failed", "boom");
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "p9" },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("on_fail: recovery logged under same run id; token cleared once", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: "printf recovered"\n`,
      m: `steps:\n  - shell: "exit 1"\non_fail: recover\n`,
    });
    const tokens: (string | null)[] = [];
    const { deps } = mockDeps({
      reportToken: async (_paneId, value) => {
        tokens.push(value);
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "p9" },
      deps,
    });
    expect(result.ok).toBe(true);
    const entries = await readRunLog();
    expect(entries.map((e) => e.workflow)).toEqual(["m", "recover", "m"]);
    expect(entries.every((e) => e.run === entries[0]?.run)).toBe(true);
    expect(entries[0]).toMatchObject({ step: 1, ok: false });
    expect(entries[1]).toMatchObject({ workflow: "recover", step: 1, ok: true });
    expect(entries[2]).toMatchObject({ workflow: "m", ok: true });
    expect(entries[2]?.step).toBeUndefined();
    expect(tokens.filter((t) => t === null)).toHaveLength(1);
    expect(tokens.at(-1)).toBeNull();
  });

  test("needsSession without paneId fails; on_fail not run", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: "printf recovered"\n`,
      m: `steps:\n  - shell: cat\n    stdin: "{session}"\non_fail: recover\n`,
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
    if (!result.ok) {
      expect(result.error).toContain("session handoff must be launched from an agent pane");
    }
    expect(notes).toHaveLength(1);
    const entries = await readRunLog();
    expect(entries.map((e) => e.workflow)).toEqual(["m"]);
    expect(entries.some((e) => e.workflow === "recover")).toBe(false);
  });

  test("needsSession calls sessionText and substitutes into stdin", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: cat\n    stdin: "{session}"\n`,
    });
    const seen: string[] = [];
    const { deps } = mockDeps({
      sessionText: async (paneId) => {
        seen.push(paneId);
        return "user:\nhello session";
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "pane-42" },
      deps,
    });
    expect(seen).toEqual(["pane-42"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toBe("user:\nhello session");
  });

  test("{session_file} yields a temp path readable during the run, removed after", async () => {
    const transcript = "user:\nHERDR_EOF\n'quote\" $(reject) `tick`\nlast line";
    const root = await repoWith({
      m: `steps:\n  - shell: sh -s\n    stdin: |\n      P='{session_file}'\n      printf %s "$P" > path.txt\n      cat "$P"\n`,
    });
    const { deps } = mockDeps({ sessionText: async () => transcript });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "pane-42" },
      deps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toBe(transcript);
    const path = await Bun.file(`${root}/path.txt`).text();
    expect(path).toMatch(/hwf-session-/);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("runWorkflow passes opts.sessions to sessionText", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: cat\n    stdin: "{session}"\n`,
    });
    let passed: unknown;
    const sessions = { codex: ["echo", "hi"] };
    const { deps } = mockDeps({
      sessionText: async (_paneId, sess) => {
        passed = sess;
        return "from sessions";
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      sessions,
      ctx: { selection: "", cwd: root, paneId: "p1" },
      deps,
    });
    expect(passed).toEqual(sessions);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toBe("from sessions");
  });

  test("sessionText throw runs on_fail with {error} filled", async () => {
    const root = await repoWith({
      recover: `steps:\n  - shell: cat\n    stdin: "E={error}"\n`,
      m: `steps:\n  - shell: cat\n    stdin: "{session}"\non_fail: recover\n`,
    });
    const { deps } = mockDeps({
      sessionText: async () => {
        throw new HerdrError("session_file_missing", "session file not found: /tmp/x.jsonl");
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "p1" },
      deps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.last).toContain("E=step 0: session file not found: /tmp/x.jsonl");
    const entries = await readRunLog();
    expect(entries.some((e) => e.workflow === "recover")).toBe(true);
  });

  test("sessionText throw without on_fail fails with its message", async () => {
    const root = await repoWith({
      m: `steps:\n  - shell: cat\n    stdin: "{session}"\n`,
    });
    const { deps } = mockDeps({
      sessionText: async () => {
        throw new HerdrError("session_file_missing", "session file not found: /tmp/x.jsonl");
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, paneId: "p1" },
      deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("session file not found: /tmp/x.jsonl");
  });

  test("two agent opens track {prev_tab} for tab.close", async () => {
    const root = await repoWith({
      m: `steps:
  - agent: claude
    wait: done
    timeout: 5
  - agent: claude
    prompt: "{last}"
  - herdr: tab.close
  - herdr: tab.close
    params:
      tab_id: "{prev_tab}"
`,
    });
    let n = 0;
    const reads: { source?: string; lines?: number }[] = [];
    const { deps, calls } = mockDeps({
      layoutApply: async () => {
        n += 1;
        return { tabId: `tab-${n}`, paneId: `pane-${n}`, workspaceId: "w1" };
      },
      agentStatus: async () => "done",
      paneRead: async (_paneId, opts) => {
        reads.push(opts ?? {});
        return "handoff-body";
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "source-tab", paneId: "src" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "tab.close")).toEqual([
      {
        method: "tab.close",
        params: { tab_id: "source-tab", pane_id: "src", workspace_id: "w1" },
      },
      {
        method: "tab.close",
        params: { tab_id: "tab-1", pane_id: "src", workspace_id: "w1" },
      },
    ]);
    expect(reads[0]?.lines).toBe(100_000);
    expect(reads[0]?.source).toBe("recent-unwrapped");
  });

  test('agent: "{agent}" resolves from invoking pane', async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: "{agent}"\n    prompt: go\n`,
    });
    const { deps, layouts } = mockDeps({
      agentLabel: async () => "codex",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"], codex: ["codex", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "p1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect((layouts[0] as { command: string[] }).command).toEqual(["codex", "go"]);
  });

  test('agent: "{agent}" fails when label not in config', async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: "{agent}"\n    prompt: go\n`,
    });
    const { deps } = mockDeps({
      agentLabel: async () => "gemini",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "p1" },
      deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("gemini");
  });
});
