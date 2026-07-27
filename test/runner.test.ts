import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../src/herdr";
import { runLogPath, type RunLogEntry } from "../src/runlog";
import { platformName } from "../src/config";
import { runWorkflow, resolveInputValues, type RunnerDeps } from "../src/run/runner";
import { runShellStep } from "../src/run/steps/shell";

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
    paneClose: async () => undefined,
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

  test("{platform} builtin substitutes in argv and HWF_platform env", async () => {
    const here = platformName();
    const root = await repoWith({
      m: `steps:
  - run: [printf, "%s", "{platform}"]
    out: plat
  - run: [sh, -c, 'test "{plat}" = "$HWF_platform"']
  - run: [sh, -c, 'test "$HWF_platform" = "${here}"']
`,
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

  test("when: == skips the other OS and runs this one", async () => {
    const here = platformName();
    const other = here === "windows" ? "macos" : "windows";
    const root = await repoWith({
      m: `steps:
  - run: "exit 1"
    when: '{platform} == "${other}"'
  - run: "printf ran"
    when: '{platform} == "${here}"'
  - run: "printf ran-too"
    when: '{platform} != "${other}"'
  - run: "exit 1"
    when: '{platform} != "${here}"'
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
      onProgress: (i, _n, _label, outcome) => {
        if (outcome) outcomes.push(`${i}:${outcome}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(outcomes).toEqual(["1:skip", "2:ok", "3:ok", "4:skip"]);
  });

  test("when: == compares an out: binding", async () => {
    const root = await repoWith({
      m: `steps:
  - run: [printf, "%s", "main"]
    out: branch
  - run: "exit 1"
    when: '{branch} == "trunk"'
  - run: "printf ok"
    when: '{branch} == "main"'
`,
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

  test("skipped step does not trigger on_error", async () => {
    const root = await repoWith({
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
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(notes).toHaveLength(0);
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

  test("HWF_ env carries out: bindings and loop items into later shell steps", async () => {
    const root = await repoWith({
      m: `steps:
  - run: printf hello
    out: greeting
  - run: test "$HWF_greeting" = hello
  - run: test "$HWF_item" = b
    for: [b]
`,
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

  test("as: alias and {item} both bind to the current item", async () => {
    const root = await repoWith({
      m: `steps:
  - run: [sh, -c, 'test "{p}" = "{item}"']
    for: [a, b]
    as: p
`,
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

  test("a failing on_error keeps the original error", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: "exit 3"\n`,
      m: `steps:\n  - run: "exit 1"\non_error: recover\n`,
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
    expect(result).toMatchObject({
      error: expect.stringContaining("on_error also failed"),
    });
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

  test("agent out binds exact file content and removes the temporary file", async () => {
    const root = await repoWith({
      m: `steps:
  - agent: claude
    prompt: make a handoff
    out: brief
  - run: [printf, "%s", "{brief}"]
`,
    });
    const expected = "Continue the work.\n\n## Next steps\n1. Run tests\n\n";
    let outputPath = "";
    let captured = "";
    const { deps } = mockDeps({
      layoutApply: async (params) => {
        const prompt = (params.root as { command: string[] }).command[1]!;
        const match = /exact absolute path, overwriting it:\n([^\n]+)\n/.exec(prompt);
        outputPath = match?.[1] ?? "";
        await writeFile(outputPath, expected);
        return { tabId: "t1", paneId: "p1", workspaceId: "w1" };
      },
      agentStatus: async () => "done",
      paneRead: async () => {
        throw new Error("agent out must not read terminal content");
      },
      runArgv: async (argv) => {
        captured = argv[2] ?? "";
        return { ok: true, stdout: captured, stderr: "" };
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
    expect(captured).toBe(expected);
    expect(outputPath).not.toBe("");
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test("agent out fails when the agent writes an empty file", async () => {
    const root = await repoWith({
      m: `steps:
  - agent: claude
    prompt: make a handoff
    out: brief
`,
    });
    const { deps, notes } = mockDeps({
      layoutApply: async (params) => {
        const prompt = (params.root as { command: string[] }).command[1]!;
        const match = /exact absolute path, overwriting it:\n([^\n]+)\n/.exec(prompt);
        await writeFile(match?.[1] ?? "", "");
        return { tabId: "t1", paneId: "p1", workspaceId: "w1" };
      },
      agentStatus: async () => "done",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "step 1: agent did not write output 'brief'" });
    expect(notes[0]).toContain("agent did not write output 'brief'");
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

  test("use: when skips the child and binds exported outs empty", async () => {
    const root = await repoWith({
      part: `steps:\n  - run: "exit 1"\n    out: report\n`,
      ship: `steps:\n  - run: "true"\n    out: diff\n  - use: part\n    when: "{diff}"\n  - run: [printf, "%s", "{report}"]\n`,
    });
    let captured = "";
    const { deps } = mockDeps({
      runArgv: async (argv) => {
        captured = argv[2] ?? "";
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    const outcomes: string[] = [];
    const result = await runWorkflow({
      name: "ship",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, _label, outcome) => outcomes.push(outcome ?? "ok"),
    });
    expect(result.ok).toBe(true);
    expect(outcomes).toContain("skip");
    expect(captured).toBe("");
  });

  test("{platform} reaches use: children", async () => {
    const here = platformName();
    const other = here === "windows" ? "macos" : "windows";
    const root = await repoWith({
      part: `steps:\n  - run: "exit 1"\n    when: '{platform} == "${other}"'\n  - run: [printf, "%s", "{platform}"]\n    out: plat\n`,
      ship: `steps:\n  - use: part\n  - run: [sh, -c, 'test "{plat}" = "${here}"']\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "ship",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("session substitutes but is not exported as HWF_session", async () => {
    const root = await repoWith({
      m: `steps:\n  - run: [printf, "%s", "{session}"]\n`,
    });
    let argvSeen: string[] = [];
    let envSeen: NodeJS.ProcessEnv = {};
    const { deps } = mockDeps({
      sessionText: async () => "transcript",
      runArgv: async (argv, opts) => {
        argvSeen = argv;
        envSeen = opts?.env ?? {};
        return { ok: true, stdout: "", stderr: "" };
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
    expect(argvSeen[2]).toBe("transcript");
    expect(envSeen.HWF_session).toBeUndefined();
    expect(envSeen.HWF_session_file).toContain("hwf-session-");
  });

  test("oversized binding fails with a named env error instead of E2BIG", async () => {
    const root = await repoWith({
      m: `inputs:\n  big: text\nsteps:\n  - run: 'printf %s "$HWF_big"'\n`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { big: "x".repeat(30 * 1024) },
      deps,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("HWF_big");
    expect(result.error).toContain("environment block too large for spawn");
  });

  test("env-cap failure short-circuits on_error and reports the original step", async () => {
    const root = await repoWith({
      recover: `steps:\n  - run: "printf recovered"\n`,
      m: `inputs:\n  big: text\non_error: recover\nsteps:\n  - run: 'printf %s "$HWF_big$HWF_big"'\n    out: huge\n  - run: "true"\n`,
    });
    const { deps, notes } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { big: "x".repeat(20 * 1024) },
      deps,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("step 2");
    expect(result.error).toContain("environment block too large for spawn");
    expect(notes).toHaveLength(1);
    expect((await readRunLog()).some((e) => e.workflow === "recover")).toBe(false);
  });

  test("false eq guard skips a step even with an oversized binding", async () => {
    const root = await repoWith({
      m: `inputs:\n  big: text\nsteps:\n  - run: 'printf %s "$HWF_big$HWF_big"'\n    out: huge\n  - run: "exit 1"\n    when: '{huge} == "never"'\n`,
    });
    const { deps } = mockDeps();
    const outcomes: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      inputs: { big: "x".repeat(20 * 1024) },
      deps,
      onProgress: (i, _n, _label, outcome) => {
        if (outcome) outcomes.push(`${i}:${outcome}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(outcomes).toEqual(["1:ok", "2:skip"]);
  });

  test("session file persists after the run for background handoff", async () => {
    const root = await repoWith({
      m: `steps:\n  - run: [printf, "%s", "{session_file}"]\n`,
    });
    let path = "";
    const { deps } = mockDeps({
      sessionText: async () => "transcript-body",
      runArgv: async (argv) => {
        path = argv[2] ?? "";
        return { ok: true, stdout: "", stderr: "" };
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
    expect(path).toContain("hwf-session-");
    expect(await Bun.file(path).text()).toBe("transcript-body");
    await rm(path, { force: true });
  });

  test("notification.show fails the step when herdr reports shown:false", async () => {
    const root = await repoWith({
      m: `steps:\n  - notification.show: { title: hi }\n`,
    });
    const { deps } = mockDeps({
      herdrCall: async () => ({ shown: false, reason: "disabled" }),
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "step 1: notification not shown: disabled" });
  });

  test("notification.show retries while herdr reports busy", async () => {
    const root = await repoWith({
      m: `steps:\n  - notification.show: { title: hi }\n`,
    });
    let calls = 0;
    const { deps } = mockDeps({
      sleep: async () => undefined,
      herdrCall: async () => {
        calls++;
        return calls < 3 ? { shown: false, reason: "busy" } : { shown: true };
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("notification.show passes when herdr reports shown:true", async () => {
    const root = await repoWith({
      m: `steps:\n  - notification.show: { title: hi }\n`,
    });
    const { deps } = mockDeps({
      herdrCall: async () => ({ shown: true }),
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("layout.apply with tab_id skips the workspace_id autofill", async () => {
    const root = await repoWith({
      pinned: `steps:\n  - layout.apply: { tab_id: t9, root: { type: pane } }\n`,
      unpinned: `steps:\n  - layout.apply: { root: { type: pane } }\n`,
    });
    const { deps, calls } = mockDeps();
    for (const name of ["pinned", "unpinned"]) {
      const result = await runWorkflow({
        name,
        repoRoot: root,
        agents: {},
        ctx: { selection: "", cwd: root, workspaceId: "w1" },
        deps,
      });
      expect(result.ok).toBe(true);
    }
    expect(calls[0]!.params.tab_id).toBe("t9");
    expect("workspace_id" in calls[0]!.params).toBe(false);
    expect(calls[1]!.params.workspace_id).toBe("w1");
  });

  test("layout.apply with empty tab_id still autofills workspace_id", async () => {
    const root = await repoWith({
      m: `steps:\n  - layout.apply: { tab_id: "", root: { type: pane } }\n`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]!.params.tab_id).toBe("");
    expect(calls[0]!.params.workspace_id).toBe("w1");
  });

  test("detached in: here run returns immediately and the child keeps running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-detach-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const root = await repoWith({
      m: `steps:\n  - run: [sh, -c, "sleep 1 && touch ${marker}"]\n    wait: false\n`,
    });
    const { deps } = mockDeps();
    const start = Date.now();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: {},
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(900);
    expect(await Bun.file(marker).exists()).toBe(false);
    await Bun.sleep(1600);
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("detached scalar run does not arm the timeout killer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-detach-to-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const root = await repoWith({
      m: `steps:\n  - run: sleep 2 && touch ${marker}\n    wait: false\n    timeout: 1\n`,
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
    await Bun.sleep(2600);
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("detached child inherits the parent environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-detach-env-"));
    dirs.push(dir);
    const marker = join(dir, "env");
    process.env.HWF_DETACH_TEST = "inherited";
    try {
      const root = await repoWith({
        m: `steps:\n  - run: [sh, -c, "printf %s \\"$HWF_DETACH_TEST\\" > ${marker}"]\n    wait: false\n`,
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
      for (let i = 0; i < 50 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(50);
      expect(await Bun.file(marker).text()).toBe("inherited");
    } finally {
      delete process.env.HWF_DETACH_TEST;
    }
  });

  test("focus: false reaches layout.apply; default stays true", async () => {
    const root = await repoWith({
      bg: `steps:\n  - run: sleep 5\n    in: tab\n    focus: false\n    wait: false\n`,
      fg: `steps:\n  - run: sleep 5\n    in: tab\n    wait: false\n`,
    });
    const { deps, layouts } = mockDeps();
    for (const name of ["bg", "fg"]) {
      const result = await runWorkflow({
        name,
        repoRoot: root,
        agents: {},
        ctx: { selection: "", cwd: root, workspaceId: "w1" },
        deps,
      });
      expect(result.ok).toBe(true);
    }
    expect((layouts[0] as { focus: boolean }).focus).toBe(false);
    expect((layouts[1] as { focus: boolean }).focus).toBe(true);
  });

  test("agent close: true reaps pane and tab after out is captured", async () => {
    const root = await repoWith({
      m: `steps:
  - agent: claude
    prompt: make a handoff
    out: brief
    close: true
  - run: [printf, "%s", "{brief}"]
`,
    });
    const closed: { panes: string[]; tabs: string[] } = { panes: [], tabs: [] };
    let captured = "";
    const { deps } = mockDeps({
      layoutApply: async (params) => {
        const prompt = (params.root as { command: string[] }).command[1]!;
        const match = /exact absolute path, overwriting it:\n([^\n]+)\n/.exec(prompt);
        await writeFile(match?.[1] ?? "", "the brief");
        return { tabId: "t7", paneId: "p7", workspaceId: "w1" };
      },
      agentStatus: async () => "done",
      paneClose: async (paneId) => {
        closed.panes.push(paneId);
      },
      tabClose: async (tabId) => {
        closed.tabs.push(tabId);
      },
      runArgv: async (argv) => {
        captured = argv[2] ?? "";
        return { ok: true, stdout: "", stderr: "" };
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
    expect(captured).toBe("the brief");
    expect(closed).toEqual({ panes: ["p7"], tabs: ["t7"] });
  });

  test("agent close: true on a split closes only the pane", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n    in: right\n    close: true\n`,
    });
    const closed: { panes: string[]; tabs: string[] } = { panes: [], tabs: [] };
    const { deps } = mockDeps({
      agentStatus: async () => "done",
      paneClose: async (paneId) => {
        closed.panes.push(paneId);
      },
      tabClose: async (tabId) => {
        closed.tabs.push(tabId);
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      agents: { claude: ["claude", "{prompt}"] },
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "t0", paneId: "p0" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(closed).toEqual({ panes: ["p1"], tabs: [] });
  });

  test("agent close: true also closes on step failure", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n    out: brief\n    close: true\n`,
    });
    const closed: string[] = [];
    const { deps } = mockDeps({
      layoutApply: async (params) => {
        const prompt = (params.root as { command: string[] }).command[1]!;
        const match = /exact absolute path, overwriting it:\n([^\n]+)\n/.exec(prompt);
        await writeFile(match?.[1] ?? "", "");
        return { tabId: "t7", paneId: "p7", workspaceId: "w1" };
      },
      agentStatus: async () => "done",
      paneClose: async (paneId) => {
        closed.push(paneId);
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
    expect(closed).toEqual(["p7"]);
  });

  test("agent without close: leaves the pane alone", async () => {
    const root = await repoWith({
      m: `steps:\n  - agent: claude\n    prompt: hi\n`,
    });
    const closed: string[] = [];
    const { deps } = mockDeps({
      agentStatus: async () => "done",
      paneClose: async (paneId) => {
        closed.push(paneId);
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
    expect(closed).toEqual([]);
  });
});
