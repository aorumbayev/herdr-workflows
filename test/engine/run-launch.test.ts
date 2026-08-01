import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickerSeams, type PickerState } from "../../src/picker";
import type { ChromeKeyEvent } from "../../src/chrome";
import { resolvePaletteLetter } from "../../src/picker";
import { LIST_HINT, selectedListEntry } from "../../src/picker";

const { attachRunsBrowser, launchWorkbenchRoute, tryOpenActionsPalette } = pickerSeams;
import {
  buildIdentity,
  launchDetachedRun,
  launchDetachedWeb,
  parseLaunchPayload,
  retireOnCodeChange,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "../../src/engine";
import type { LoadedWorkflow } from "../../src/workflow/grammar";
import { fakePickerChrome, type FakePickerChrome } from "../fakes/picker-chrome-fake";

function captureSpawn(): {
  seen: { argv: string[]; env?: NodeJS.ProcessEnv; stdout?: unknown; stderr?: unknown };
  spawn: typeof Bun.spawn;
} {
  const seen: {
    argv: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: unknown;
    stderr?: unknown;
  } = { argv: [] };
  const spawn = ((argv, opts) => {
    seen.argv = [...argv];
    seen.env = opts?.env as NodeJS.ProcessEnv | undefined;
    seen.stdout = opts?.stdout;
    seen.stderr = opts?.stderr;
    return {
      stdin: { write() {}, end() {} },
      stdout: null,
      stderr: null,
      exited: Promise.resolve(0),
      unref() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  return { seen, spawn };
}

const dirs: string[] = [];
const prevState = process.env.HERDR_PLUGIN_STATE_DIR;
const prevConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  if (prevConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevConfig;
});

function pickerState(
  overrides: Partial<PickerState> & { chrome?: FakePickerChrome } = {},
): PickerState & { chrome: FakePickerChrome } {
  const { chrome: chromeOverride, runs, ...rest } = overrides;
  const chrome = chromeOverride ?? fakePickerChrome();
  const state = {
    mode: "list" as const,
    entries: [],
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    choiceOptions: [],
    running: false,
    repoRoot: "/repo",
    config: { profiles: {}, transcripts: {} },
    ctx: {
      selection: "",
      cwd: "/repo",
      paneId: "wCaller:p1",
      tabId: "wCaller:t1",
      workspaceId: "wCaller",
    },
    loadWorkflow: async (entry: { name: string; file: string }) =>
      ({
        name: entry.name,
        file: entry.file,
        version: "v1alpha1",
        hidden: false,
        steps: [],
        inputs: [],
        repoOwned: true,
        needsTranscript: false,
      }) satisfies LoadedWorkflow,
    contentWidth: 80,
    inputDomains: {},
    customChoice: false,
    reloadEntries: async () => [],
    savedWorkflowFilter: "",
    ...rest,
    chrome,
  } as unknown as PickerState & { chrome: FakePickerChrome };
  if (runs) state.runs = runs;
  else attachRunsBrowser(state);
  return state;
}

function startPickerRun(state: PickerState, entry: Parameters<PickerState["runs"]["startRun"]>[0]) {
  return state.runs.startRun(entry, {
    ctx: state.ctx,
    config: state.config,
    inputValues: state.inputValues,
    inputDomains: state.inputDomains,
    workflow: state.workflow,
    loadWorkflow: state.loadWorkflow,
    launchRun: state.launchRun,
    getExit: () => state.exit,
  });
}

describe("launch argv and env", () => {
  test("detached run pins caller pane/tab/workspace in child env", () => {
    const { seen, spawn } = captureSpawn();
    launchDetachedRun({
      name: "sleep",
      repoRoot: "/repo",
      ctx: {
        selection: "sel",
        cwd: "/repo",
        paneId: "wCaller:p1",
        tabId: "wCaller:t1",
        workspaceId: "wCaller",
        worktreePath: "/repo/.wt",
      },
      inputs: {},
      onProgressLine: () => undefined,
      spawn,
    });
    expect(seen.env?.HERDR_PANE_ID).toBe("wCaller:p1");
    expect(seen.env?.HERDR_TAB_ID).toBe("wCaller:t1");
    expect(seen.env?.HERDR_WORKSPACE_ID).toBe("wCaller");
    expect(seen.env?.HERDR_WORKFLOWS_REPO_ROOT).toBe("/repo");
    const json = JSON.parse(String(seen.env?.HERDR_PLUGIN_CONTEXT_JSON)) as Record<string, unknown>;
    expect(json.focused_pane_id).toBe("wCaller:p1");
    expect(json.tab_id).toBe("wCaller:t1");
    expect(json.workspace_id).toBe("wCaller");
    expect(json.selected_text).toBe("sel");
    expect((json.worktree as { path: string }).path).toBe("/repo/.wt");
  });

  test("detached run argv is self-exec plus name and launch-payload flag", () => {
    const { seen, spawn } = captureSpawn();
    launchDetachedRun({
      name: "sleep",
      repoRoot: "/repo",
      ctx: { selection: "", cwd: "/repo" },
      inputs: {},
      onProgressLine: () => undefined,
      spawn,
    });
    expect(seen.argv[0]).toBe(process.execPath);
    expect(seen.argv).toContain("run");
    expect(seen.argv.slice(-2)).toEqual(["sleep", "--launch-payload"]);
    // Under bun test, argv[1] is a real script — self-exec re-passes it.
    expect(seen.argv[1]).toBe(process.argv[1]);
    expect(seen.argv[2]).toBe("run");
  });

  test("compiled /$bunfs/ entry is not a script — build identity uses the binary", () => {
    // /$bunfs/ is not a host file; identity comes from execPath (same rule self-exec uses).
    expect(buildIdentity("/$bunfs/root/herdr-workflows", process.execPath)).toBeString();
  });

  test("detached web argv reuses the same self-exec rules", () => {
    const { seen, spawn } = captureSpawn();
    launchDetachedWeb({
      route: "w=repo:deploy",
      repoRoot: "/repo",
      spawn,
    });
    expect(seen.argv[0]).toBe(process.execPath);
    expect(seen.argv[1]).toBe(process.argv[1]);
    expect(seen.argv.slice(-2)).toEqual(["web", "w=repo:deploy"]);
  });

  test("parseLaunchPayload round-trips inputs", () => {
    const payload = { name: "sleep", inputs: { focus: "x" } };
    expect(parseLaunchPayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("launch payload forwards domains and round-trips snapshots", () => {
    const payload = {
      name: "dyn",
      inputs: { branch: "one" },
      domains: { branch: ["one", "two"] },
    };
    expect(payload.domains).toEqual({ branch: ["one", "two"] });
    expect(JSON.stringify(payload)).not.toContain("argv");
    expect(parseLaunchPayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("parseLaunchPayload rejects invalid shapes with stable messages", () => {
    expect(() => parseLaunchPayload("{")).toThrow("launch payload is not valid JSON");
    expect(() => parseLaunchPayload("[]")).toThrow("launch payload must be a JSON object");
    expect(() => parseLaunchPayload("{}")).toThrow("launch payload requires a string name");
    expect(() => parseLaunchPayload(JSON.stringify({ name: "x", inputs: [] }))).toThrow(
      "launch payload inputs must be an object",
    );
    expect(() => parseLaunchPayload(JSON.stringify({ name: "x", inputs: { a: 1 } }))).toThrow(
      "launch payload inputs.a must be a string",
    );
    expect(() => parseLaunchPayload(JSON.stringify({ name: "x", domains: [] }))).toThrow(
      "launch payload domains must be an object",
    );
    expect(() => parseLaunchPayload(JSON.stringify({ name: "x", domains: { a: [1] } }))).toThrow(
      "launch payload domains.a must be a string array",
    );
    expect(() => parseLaunchPayload(JSON.stringify({ name: "x", runId: "" }))).toThrow(
      "launch payload runId must be a non-empty string",
    );
  });
});

describe("picker detached run", () => {
  test("dismissing the popup leaves the run to completion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "hwf-detach-state-"));
    dirs.push(stateDir);
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

    let resolveSleep!: () => void;
    const slept = new Promise<void>((resolve) => {
      resolveSleep = resolve;
    });
    let finished = false;

    const launchRun = (req: LaunchRunRequest): DetachedRunHandle => {
      let detached = false;
      const result = (async () => {
        req.onProgressLine("[1/1] sleep");
        req.onHistoryAck?.(
          `@hwf-history:claimed ${req.runId ?? "00000000-0000-4000-8000-000000000001"}`,
        );
        await slept;
        finished = true;
        return { ok: true, detail: "" };
      })();
      return {
        result,
        detach: () => {
          detached = true;
          void detached;
        },
      };
    };

    const state = pickerState({ launchRun });
    const running = startPickerRun(state, {
      name: "sleepy",
      source: "repo",
      file: "/repo/.hwf/workflows/sleepy.yaml",
    });
    await Bun.sleep(10);
    expect(state.runs.running).toBe(true);
    expect(state.runs.isDetail()).toBe(true);
    expect(state.chrome.lastFooter()).toContain("esc back");

    state.runs.dispose();
    state.exit = { code: 0 };
    state.chrome.destroy();

    resolveSleep();
    await running;
    expect(finished).toBe(true);
    expect(state.exit?.code).toBe(0);
  });

  test("detached launch receives the original invocation identity", async () => {
    let seen: LaunchRunRequest | undefined;
    const launchRun = (req: LaunchRunRequest): DetachedRunHandle => {
      seen = req;
      return {
        result: Promise.resolve({ ok: true, detail: "" }),
        detach: () => undefined,
      };
    };
    const state = pickerState({
      launchRun,
      ctx: {
        selection: "",
        cwd: "/repo",
        paneId: "wOrig:p9",
        tabId: "wOrig:t2",
        workspaceId: "wOrig",
      },
    });
    await startPickerRun(state, {
      name: "quick",
      source: "repo",
      file: "/repo/.hwf/workflows/quick.yaml",
    });
    expect(seen?.ctx.paneId).toBe("wOrig:p9");
    expect(seen?.ctx.tabId).toBe("wOrig:t2");
    expect(seen?.ctx.workspaceId).toBe("wOrig");
    expect(seen?.repoRoot).toBe("/repo");
  });

  test("a single-step local workflow still reports its outcome through the picker", async () => {
    const state = pickerState({
      launchRun: (req) => ({
        result: (async () => {
          req.onHistoryAck?.("@hwf-history:unavailable");
          req.onProgressLine("[1/1] run: true");
          return { ok: true, detail: "" };
        })(),
        detach: () => undefined,
      }),
    });
    await startPickerRun(state, {
      name: "quick",
      source: "repo",
      file: "/repo/.hwf/workflows/quick.yaml",
    });
    expect(state.chrome.lastStatus()).toContain("[1/1]");
    expect(state.chrome.lastStatus()).toContain("HISTORY UNAVAILABLE");
    expect(state.runs.isDetail()).toBe(true);
    expect(state.exit).toBeUndefined();
    expect(state.runs.running).toBe(false);
  });

  test("failed run stays in detail and forwards domains on launch", async () => {
    let seen: LaunchRunRequest | undefined;
    const state = pickerState({
      inputDomains: { branch: ["one", "two"] },
      inputValues: { branch: "one" },
      launchRun: (req) => {
        seen = req;
        return {
          result: Promise.resolve({ ok: false, detail: "boom" }),
          detach: () => undefined,
        };
      },
    });
    await startPickerRun(state, {
      name: "dyn",
      source: "repo",
      file: "/repo/.hwf/workflows/dyn.yaml",
    });
    expect(seen?.domains).toEqual({ branch: ["one", "two"] });
    expect(seen?.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(state.runs.running).toBe(false);
    expect(state.runs.isDetail()).toBe(true);
    expect(state.chrome.lastStatus()).toMatch(/LAUNCH FAILED|FAILED|boom/);
  });
});

describe("launchDetachedRun process", () => {
  test("child keeps the caller pane ids in its env and outlives detach", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-detach-child-"));
    dirs.push(root);
    const marker = join(root, "done.txt");
    const envFile = join(root, "env.json");
    const script = join(root, "child.ts");
    await writeFile(
      script,
      `
const env = {
  pane: process.env.HERDR_PANE_ID,
  tab: process.env.HERDR_TAB_ID,
  workspace: process.env.HERDR_WORKSPACE_ID,
  repo: process.env.HERDR_WORKFLOWS_REPO_ROOT,
};
await Bun.write(${JSON.stringify(envFile)}, JSON.stringify(env));
await Bun.sleep(400);
await Bun.write(${JSON.stringify(marker)}, "ok");
`,
    );

    const handle = launchDetachedRun({
      name: "ignored",
      repoRoot: root,
      ctx: {
        selection: "",
        cwd: root,
        paneId: "wLive:p1",
        tabId: "wLive:t1",
        workspaceId: "wLive",
      },
      inputs: {},
      onProgressLine: () => undefined,
      spawn: ((_argv, opts) =>
        Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })) as typeof Bun.spawn,
    });

    await Bun.sleep(80);
    handle.detach();
    const result = await handle.result;
    expect(result).toEqual({ ok: true, detail: "detached" });

    let markerReady = false;
    for (let i = 0; i < 30; i++) {
      if (await Bun.file(marker).exists()) {
        markerReady = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(markerReady).toBe(true);
    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(env.pane).toBe("wLive:p1");
    expect(env.tab).toBe("wLive:t1");
    expect(env.workspace).toBe("wLive");
    expect(env.repo).toBe(root);
  });

  test("detach settles mid-run without waiting for child exit status", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-detach-mid-"));
    dirs.push(root);
    const marker = join(root, "done.txt");
    const ready = join(root, "ready.txt");
    const go = join(root, "go.txt");
    const script = join(root, "child-fail.ts");
    await writeFile(
      script,
      `
await Bun.write(${JSON.stringify(ready)}, "1");
for (let i = 0; i < 200; i++) {
  if (await Bun.file(${JSON.stringify(go)}).exists()) break;
  await Bun.sleep(25);
}
await Bun.write(${JSON.stringify(marker)}, "fail");
process.exit(1);
`,
    );

    const handle = launchDetachedRun({
      name: "ignored",
      repoRoot: root,
      ctx: { selection: "", cwd: root },
      inputs: {},
      onProgressLine: () => undefined,
      spawn: ((_argv, opts) =>
        Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })) as typeof Bun.spawn,
    });

    let childReady = false;
    for (let i = 0; i < 80; i++) {
      if (await Bun.file(ready).exists()) {
        childReady = true;
        break;
      }
      await Bun.sleep(25);
    }
    expect(childReady).toBe(true);

    const settled = handle.result.then((value) => value);
    handle.detach();
    const result = await settled;
    expect(result).toEqual({ ok: true, detail: "detached" });
    expect(await Bun.file(marker).exists()).toBe(false);

    await writeFile(go, "1");
    let markerReady = false;
    for (let i = 0; i < 80; i++) {
      if (await Bun.file(marker).exists()) {
        markerReady = true;
        break;
      }
      await Bun.sleep(25);
    }
    expect(markerReady).toBe(true);
  });

  test("observed failure keeps only the final diagnostic line", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-detach-bound-"));
    dirs.push(root);
    const script = join(root, "noisy-fail.ts");
    await writeFile(
      script,
      `
process.stdout.write("[1/1] run: noisy\\n");
process.stdout.write("stdout noise one\\n");
process.stdout.write("stdout noise two\\n");
process.stderr.write("stderr line one\\n");
process.stderr.write("final diagnostic\\n");
process.exit(2);
`,
    );

    const progress: string[] = [];
    const handle = launchDetachedRun({
      name: "ignored",
      repoRoot: root,
      ctx: { selection: "", cwd: root },
      inputs: {},
      onProgressLine: (line) => progress.push(line),
      spawn: ((_argv, opts) =>
        Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })) as typeof Bun.spawn,
    });

    const result = await handle.result;
    expect(result).toEqual({ ok: false, detail: "final diagnostic" });
    expect(progress).toEqual(["[1/1] run: noisy"]);
  });

  test("multi-megabyte stderr without newlines keeps a bounded diagnostic tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-detach-nonewline-"));
    dirs.push(root);
    const script = join(root, "flood-fail.ts");
    await writeFile(
      script,
      `
import { writeSync } from "node:fs";
process.stdout.write("[1/1] run: flood\\n");
const chunk = Buffer.alloc(1024 * 1024, 0x61);
for (let i = 0; i < 4; i++) writeSync(2, chunk);
writeSync(2, "TAIL-END");
process.exit(2);
`,
    );

    const before = process.memoryUsage().heapUsed;
    const handle = launchDetachedRun({
      name: "ignored",
      repoRoot: root,
      ctx: { selection: "", cwd: root },
      inputs: {},
      onProgressLine: () => undefined,
      spawn: ((_argv, opts) =>
        Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })) as typeof Bun.spawn,
    });

    const result = await handle.result;
    expect(result.ok).toBe(false);
    expect(result.detail.endsWith("TAIL-END")).toBe(true);
    expect(result.detail.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.detail.length).toBeGreaterThan(0);
    const growth = process.memoryUsage().heapUsed - before;
    expect(growth).toBeLessThan(8 * 1024 * 1024);
  });

  test("detached spawn argv never contains input values", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-detach-argv-"));
    dirs.push(root);
    const secretInput = "cred-value-9f3a";
    const payloadFile = join(root, "payload.json");
    const reader = join(root, "read-stdin.ts");
    await writeFile(
      reader,
      `
const text = await Bun.stdin.text();
await Bun.write(${JSON.stringify(payloadFile)}, text);
`,
    );
    let seenArgv: string[] = [];

    const handle = launchDetachedRun({
      name: "safe",
      repoRoot: root,
      ctx: { selection: "", cwd: root },
      inputs: { token: secretInput },
      onProgressLine: () => undefined,
      spawn: ((argv, opts) => {
        seenArgv = [...argv];
        return Bun.spawn([process.execPath, reader], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });
      }) as typeof Bun.spawn,
    });

    const result = await handle.result;
    expect(result.ok).toBe(true);
    expect(seenArgv.join("\0")).not.toContain(secretInput);
    expect(seenArgv.slice(-2)).toEqual(["safe", "--launch-payload"]);
    const payload = parseLaunchPayload(await readFile(payloadFile, "utf8"));
    expect(payload.inputs.token).toBe(secretInput);
    expect(payload.name).toBe("safe");
  });
});

describe("launchDetachedWeb", () => {
  test("pins repo root, ignores stdout, and appends stderr to plugin state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-web-launch-"));
    dirs.push(root);
    const envFile = join(root, "env.json");
    const script = join(root, "child.ts");
    await writeFile(
      script,
      `
const env = {
  repo: process.env.HERDR_WORKFLOWS_REPO_ROOT,
  state: process.env.HERDR_PLUGIN_STATE_DIR,
  config: process.env.HERDR_PLUGIN_CONFIG_DIR,
};
await Bun.write(${JSON.stringify(envFile)}, JSON.stringify(env));
`,
    );
    let seenArgv: string[] = [];
    let seenStdout: unknown;
    let seenStderr: unknown;
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const stateDir = join(root, "state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = join(root, "config");

    launchDetachedWeb({
      route: "import",
      repoRoot: root,
      spawn: ((argv, opts) => {
        seenArgv = [...argv];
        seenStdout = opts?.stdout;
        seenStderr = opts?.stderr;
        seenEnv = opts?.env as NodeJS.ProcessEnv | undefined;
        return Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });
      }) as typeof Bun.spawn,
    });

    await Bun.sleep(120);
    expect(seenArgv.at(-2)).toBe("web");
    expect(seenArgv.at(-1)).toBe("import");
    expect(seenStdout).toBe("ignore");
    expect(typeof seenStderr).toBe("number");
    expect(await Bun.file(join(stateDir, "web-launch.stderr.log")).exists()).toBe(true);
    expect(seenEnv?.HERDR_WORKFLOWS_REPO_ROOT).toBe(root);
    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(env.repo).toBe(root);
    expect(env.state).toBe(stateDir);
    expect(env.config).toBe(join(root, "config"));
  });

  test("unusable plugin state still launches with stderr ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-web-bad-state-"));
    dirs.push(root);
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "file");

    let spawned = false;
    let seenStderr: unknown;
    process.env.HERDR_PLUGIN_STATE_DIR = join(blocker, "nested");
    launchDetachedWeb({
      route: "import",
      repoRoot: root,
      spawn: ((_argv, opts) => {
        spawned = true;
        seenStderr = opts?.stderr;
        return {
          unref() {},
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    });
    expect(spawned).toBe(true);
    expect(seenStderr).toBe("ignore");
  });
});

describe("picker workbench handoff", () => {
  function key(name: string, ctrl: boolean): ChromeKeyEvent {
    let prevented = false;
    return {
      name,
      ctrl,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      number: false,
      raw: "",
      eventType: "press",
      source: "raw",
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
      get defaultPrevented() {
        return prevented;
      },
      get propagationStopped() {
        return false;
      },
    } as ChromeKeyEvent;
  }

  test("successful launch tears down picker after handoff", () => {
    const launched: LaunchWebRequest[] = [];
    const chrome = fakePickerChrome();
    chrome.setOptions([
      {
        name: "Deploy · repo",
        description: "",
        value: { entry: { name: "deploy", source: "repo", file: "/r/deploy.yaml" } },
      },
    ]);
    const state = pickerState({
      launchWeb: (req) => launched.push(req),
      chrome,
    });
    expect(selectedListEntry(state)?.source).toBe("repo");
    const action = resolvePaletteLetter("o", selectedListEntry(state));
    expect(action).toEqual({ id: "open", route: "w=repo:deploy" });
    if (action && action.id === "open") launchWorkbenchRoute(state, action.route);
    expect(launched).toEqual([{ route: "w=repo:deploy", repoRoot: "/repo" }]);
    expect(state.exit?.code).toBe(0);
    expect(chrome.destroyed).toBe(true);
  });

  test("failed launch keeps picker open with concise status", () => {
    const entry = { name: "deploy", source: "repo" as const, file: "/r/deploy.yaml" };
    const chrome = fakePickerChrome();
    chrome.showBrowser({ showFilter: true });
    chrome.setOptions([
      {
        name: "Deploy · repo",
        description: "",
        value: { entry },
      },
    ]);
    const state = pickerState({
      entries: [entry],
      launchWeb: () => {
        throw new Error("spawn ENOENT");
      },
      chrome,
    });
    launchWorkbenchRoute(state, "import");
    expect(chrome.destroyed).toBe(false);
    expect(state.exit).toBeUndefined();
    expect(state.mode).toBe("list");
    expect(chrome.statusVisible()).toBe(true);
    expect(chrome.lastStatus()).toContain("workbench failed");
    expect(chrome.lastStatus()).toContain("spawn ENOENT");
    expect(chrome.lastFooter().startsWith(LIST_HINT)).toBe(true);
    expect(chrome.lastFooter()).toMatch(/1\/1$/);
    expect(chrome.lastFooter()).toContain("enter run");
    expect(chrome.lastFooter()).not.toMatch(/enter\/esc close/);
    expect(chrome.layout()).toBe("browser");
    expect(chrome.filterVisible()).toBe(true);
    expect(selectedListEntry(state)?.name).toBe("deploy");
  });

  test("palette open without selection is noop; import launches workbench", () => {
    const launched: LaunchWebRequest[] = [];
    const chrome = fakePickerChrome();
    const state = pickerState({
      launchWeb: (req) => launched.push(req),
      chrome,
    });
    expect(resolvePaletteLetter("o", undefined)).toBeUndefined();
    expect(launched).toEqual([]);
    expect(chrome.destroyed).toBe(false);

    const imp = resolvePaletteLetter("i", undefined);
    expect(imp).toEqual({ id: "import", route: "import" });
    if (imp && imp.id === "import") launchWorkbenchRoute(state, imp.route);
    expect(launched).toEqual([{ route: "import", repoRoot: "/repo" }]);
    expect(state.exit?.code).toBe(0);
  });

  test("ctrl+k opens palette in list mode only", () => {
    const chrome = fakePickerChrome();
    chrome.setOptions([
      {
        name: "Deploy · repo",
        description: "",
        value: { entry: { name: "deploy", source: "repo", file: "/r/deploy.yaml" } },
      },
    ]);
    const state = pickerState({
      mode: "input",
      chrome,
    });
    const k = key("k", true);
    expect(tryOpenActionsPalette(state, k)).toBe(false);
    expect(k.defaultPrevented).toBe(false);
    expect(state.mode).toBe("input");

    (state as { mode: PickerState["mode"] }).mode = "list";
    const k2 = key("k", true);
    expect(tryOpenActionsPalette(state, k2)).toBe(true);
    expect(k2.defaultPrevented).toBe(true);
    expect((state as { mode: string }).mode).toBe("palette");
  });

  test("launchWorkbenchRoute refuses invalid routes", () => {
    const launched: LaunchWebRequest[] = [];
    const state = pickerState({ launchWeb: (req) => launched.push(req) });
    launchWorkbenchRoute(state, "not-a-route");
    expect(launched).toEqual([]);
    expect(state.exit).toBeUndefined();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

describe("code-change retirement", () => {
  test("a compiled entry relies on build identity, not a script watch", () => {
    // /$bunfs/ is not a host file — no script-tree watch; identity comes from the binary.
    const id = buildIdentity("/$bunfs/root/cli", process.execPath);
    expect(id).toBeString();
    const stop = retireOnCodeChange(() => undefined, undefined);
    expect(() => stop()).not.toThrow();
  });

  test("no watch target is a no-op disposer, not a failure", () => {
    let retired = 0;
    const stop = retireOnCodeChange(() => retired++, undefined);
    expect(retired).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  // Every mechanism a plugin upgrade can use to install a new build must change the identity.
  // A filesystem watch cannot see all three: on Linux, watches bind to inodes, so renaming an
  // ancestor directory — the managed-checkout case — emits nothing.
  test("build identity changes however the new build is installed", async () => {
    const base = await mkdtemp(join(tmpdir(), "hwf-build-id-"));
    dirs.push(base);
    const checkout = join(base, "checkout");
    await mkdir(join(checkout, "bin"), { recursive: true });
    const binary = join(checkout, "bin", "herdr-workflows");
    await writeFile(binary, "build-1");
    const entry = "/$bunfs/root/cli";
    const before = buildIdentity(entry, binary);
    expect(before).toBeString();

    await writeFile(binary, "build-2-rewritten-in-place");
    expect(buildIdentity(entry, binary)).not.toBe(before);

    const staged = join(base, "staged");
    await writeFile(staged, "build-3");
    await rename(staged, binary);
    const afterAtomic = buildIdentity(entry, binary);
    expect(afterAtomic).not.toBe(before);

    await rename(checkout, join(base, "checkout.old"));
    expect(buildIdentity(entry, binary)).toBeUndefined();
    expect(buildIdentity(entry, binary)).not.toBe(afterAtomic);
  });

  test("a script entry claims no build identity, since its runtime never changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-build-id-src-"));
    dirs.push(root);
    const entry = join(root, "cli.ts");
    await writeFile(entry, "export {};\n");
    expect(buildIdentity(entry, process.execPath)).toBeUndefined();
  });

  test("a watched source tree retires on served sources only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-retire-src-"));
    dirs.push(root);
    await mkdir(join(root, "workflow"), { recursive: true });
    await writeFile(join(root, "cli.ts"), "export {};\n");
    let retired = 0;
    const stop = retireOnCodeChange(() => retired++, { path: root, recursive: true });
    // The fixture's own cli.ts write can be delivered after the watcher arms, so let the
    // directory settle and start counting from a live, quiet watcher.
    await Bun.sleep(200);
    retired = 0;
    await writeFile(join(root, "notes.md"), "not served\n");
    await Bun.sleep(200);
    expect(retired).toBe(0);
    await writeFile(join(root, "workflow", "parse.ts"), "export const parsed = 1;\n");
    expect(await waitFor(() => retired > 0)).toBe(true);
    stop();
  });

  test("an unwatchable target leaves signal shutdown as the only path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-retire-missing-"));
    dirs.push(root);
    let retired = 0;
    const stop = retireOnCodeChange(() => retired++, {
      path: join(root, "absent", "herdr-workflows"),
      recursive: false,
    });
    expect(retired).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
