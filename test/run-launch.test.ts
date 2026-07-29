import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import type { InvocationContext } from "../src/config";
import { runLogPath, type RunLogEntry } from "../src/runlog";
import {
  launchWorkbenchRoute,
  LIST_HINT,
  pickerEscapeExitCode,
  selectedListEntry,
  startRun,
  tryListWorkbenchShortcut,
  type PickerState,
} from "../src/tui/picker";
import { themeFromPalette } from "../src/tui/theme";
import {
  buildInvocationEnv,
  buildLaunchPayload,
  buildRunArgs,
  buildWebLaunchEnv,
  codeWatchTarget,
  isRuntimeScriptEntry,
  launchDetachedRun,
  launchDetachedWeb,
  openWebLaunchStderr,
  parseLaunchPayload,
  retireOnCodeChange,
  selfRunArgv,
  selfWebArgv,
  webLaunchStderrPath,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "../src/tui/run-launch";
import type { LoadedWorkflow } from "../src/workflow/types";

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

function pickerState(overrides: Partial<PickerState> = {}): PickerState {
  return {
    mode: "list",
    entries: [],
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    choiceOptions: [],
    running: false,
    progressLines: [],
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
    theme: themeFromPalette(null),
    renderer: { destroy: () => undefined },
    filterRow: { visible: true },
    filter: { visible: true },
    updateHint: { visible: false, content: "" },
    listBlock: { visible: true },
    list: {
      visible: true,
      flexGrow: 0,
      height: 6,
      options: [],
      getSelectedIndex: () => 0,
    },
    status: { visible: false, flexGrow: 0, content: "" },
    detail: { visible: false, content: "" },
    rule: { visible: false, content: "" },
    promptInput: { visible: false },
    footer: { content: "" },
    ...overrides,
  } as unknown as PickerState;
}

describe("buildInvocationEnv", () => {
  test("pins the original caller pane/tab/workspace, not a host pane", () => {
    const ctx: InvocationContext = {
      selection: "sel",
      cwd: "/repo",
      paneId: "wCaller:p1",
      tabId: "wCaller:t1",
      workspaceId: "wCaller",
      worktreePath: "/repo/.wt",
    };
    const env = buildInvocationEnv(ctx, "/repo");
    expect(env.HERDR_PANE_ID).toBe("wCaller:p1");
    expect(env.HERDR_TAB_ID).toBe("wCaller:t1");
    expect(env.HERDR_WORKSPACE_ID).toBe("wCaller");
    expect(env.HERDR_WORKFLOWS_REPO_ROOT).toBe("/repo");
    const json = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON!) as Record<string, unknown>;
    expect(json.focused_pane_id).toBe("wCaller:p1");
    expect(json.tab_id).toBe("wCaller:t1");
    expect(json.workspace_id).toBe("wCaller");
    expect(json.selected_text).toBe("sel");
    expect((json.worktree as { path: string }).path).toBe("/repo/.wt");
  });
});

describe("run argv", () => {
  test("buildRunArgs keeps only the workflow name and launch-payload flag", () => {
    expect(buildRunArgs("sleep")).toEqual(["sleep", "--launch-payload"]);
  });

  test("selfRunArgv re-passes a real on-disk script entry to the runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-self-argv-"));
    dirs.push(root);
    const script = join(root, "cli.ts");
    await writeFile(script, "export {};\n");
    expect(isRuntimeScriptEntry(script)).toBe(true);
    expect(
      selfRunArgv(["sleep", "--launch-payload"], { execPath: "/runtime/bun", argv1: script }),
    ).toEqual(["/runtime/bun", script, "run", "sleep", "--launch-payload"]);
  });

  test("selfRunArgv treats compiled /$bunfs/ argv1 as the binary itself", () => {
    const entry = "/$bunfs/root/herdr-workflows";
    expect(isRuntimeScriptEntry(entry)).toBe(false);
    expect(
      selfRunArgv(["sleep", "--launch-payload"], {
        execPath: "/opt/herdr-workflows",
        argv1: entry,
      }),
    ).toEqual(["/opt/herdr-workflows", "run", "sleep", "--launch-payload"]);
  });

  test("selfWebArgv reuses the same self-exec rules for web routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-self-web-"));
    dirs.push(root);
    const script = join(root, "cli.ts");
    await writeFile(script, "export {};\n");
    expect(
      selfWebArgv(["w=repo:deploy", "--no-open"], { execPath: "/runtime/bun", argv1: script }),
    ).toEqual(["/runtime/bun", script, "web", "w=repo:deploy", "--no-open"]);
    expect(
      selfWebArgv(["import"], {
        execPath: "/opt/herdr-workflows",
        argv1: "/$bunfs/root/herdr-workflows",
      }),
    ).toEqual(["/opt/herdr-workflows", "web", "import"]);
  });

  test("parseLaunchPayload round-trips inputs", () => {
    const payload = buildLaunchPayload("sleep", { focus: "x" });
    expect(parseLaunchPayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("launch payload forwards domains and round-trips snapshots", () => {
    const payload = buildLaunchPayload("dyn", { branch: "one" }, { branch: ["one", "two"] });
    expect(payload.domains).toEqual({ branch: ["one", "two"] });
    expect(JSON.stringify(payload)).not.toContain("argv");
    expect(parseLaunchPayload(JSON.stringify(payload))).toEqual(payload);
  });
});

describe("picker detached run", () => {
  test("dismissing the popup leaves the run to completion in the run log", async () => {
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
        await slept;
        finished = true;
        const entry: RunLogEntry = {
          ts: new Date().toISOString(),
          run: "detach01",
          workflow: req.name,
          step: 1,
          total: 1,
          label: "sleep",
          ok: true,
        };
        await mkdir(stateDir, { recursive: true });
        await Bun.write(runLogPath(), `${JSON.stringify(entry)}\n`);
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
    const running = startRun(state, {
      name: "sleepy",
      source: "repo",
      file: "/repo/.hwf/workflows/sleepy.yaml",
    });
    await Bun.sleep(10);
    expect(state.running).toBe(true);
    expect(String(state.footer.content)).toContain("dismiss");

    state.runHandle?.detach();
    state.exit = { code: 0 };
    state.renderer.destroy();

    resolveSleep();
    await running;
    expect(finished).toBe(true);
    expect(state.exit?.code).toBe(0);

    const log = (await readFile(runLogPath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunLogEntry);
    expect(log.some((e) => e.workflow === "sleepy" && e.ok)).toBe(true);
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
    await startRun(state, {
      name: "quick",
      source: "repo",
      file: "/repo/.hwf/workflows/quick.yaml",
    });
    expect(seen?.ctx.paneId).toBe("wOrig:p9");
    expect(seen?.ctx.tabId).toBe("wOrig:t2");
    expect(seen?.ctx.workspaceId).toBe("wOrig");
    const env = buildInvocationEnv(seen!.ctx, seen!.repoRoot);
    expect(env.HERDR_PANE_ID).toBe("wOrig:p9");
  });

  test("a single-step local workflow still reports its outcome through the picker", async () => {
    const launchRun = (req: LaunchRunRequest): DetachedRunHandle => ({
      result: (async () => {
        req.onProgressLine("[1/1] run: true");
        return { ok: true, detail: "" };
      })(),
      detach: () => undefined,
    });
    let destroyed = false;
    const state = pickerState({
      launchRun,
      renderer: {
        destroy: () => {
          destroyed = true;
        },
      } as PickerState["renderer"],
    });
    await startRun(state, {
      name: "quick",
      source: "repo",
      file: "/repo/.hwf/workflows/quick.yaml",
    });
    expect(state.progressLines.some((line) => line.includes("[1/1]"))).toBe(true);
    expect(state.exit?.code).toBe(0);
    expect(destroyed).toBe(true);
  });

  test("failed run Escape dismisses nonzero and forwards domains on launch", async () => {
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
    await startRun(state, {
      name: "dyn",
      source: "repo",
      file: "/repo/.hwf/workflows/dyn.yaml",
    });
    expect(seen?.domains).toEqual({ branch: ["one", "two"] });
    expect(state.running).toBe(false);
    expect(state.exit).toBeUndefined();
    expect(pickerEscapeExitCode(state.mode, state.running)).toBe(1);
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
    expect(webLaunchStderrPath(stateDir)).toBe(join(stateDir, "web-launch.stderr.log"));
    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(env.repo).toBe(root);
    expect(env.state).toBe(stateDir);
    expect(env.config).toBe(join(root, "config"));
    expect(buildWebLaunchEnv(root).HERDR_WORKFLOWS_REPO_ROOT).toBe(root);
  });

  test("unusable plugin state still launches with stderr ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-web-bad-state-"));
    dirs.push(root);
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "file");
    expect(openWebLaunchStderr(join(blocker, "nested"))).toBe("ignore");

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
  function key(name: string, ctrl: boolean): KeyEvent {
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
    } as KeyEvent;
  }

  test("successful launch tears down picker after handoff", () => {
    const launched: LaunchWebRequest[] = [];
    let destroyed = false;
    const state = pickerState({
      launchWeb: (req) => launched.push(req),
      renderer: {
        destroy: () => {
          destroyed = true;
        },
      } as PickerState["renderer"],
      list: {
        options: [
          {
            name: "Deploy · repo",
            description: "",
            value: { entry: { name: "deploy", source: "repo", file: "/r/deploy.yaml" } },
          },
        ],
        getSelectedIndex: () => 0,
      } as unknown as PickerState["list"],
    });
    expect(selectedListEntry(state)?.source).toBe("repo");
    const k = key("e", true);
    expect(tryListWorkbenchShortcut(state, k)).toBe(true);
    expect(k.defaultPrevented).toBe(true);
    expect(launched).toEqual([{ route: "w=repo:deploy", repoRoot: "/repo" }]);
    expect(state.exit?.code).toBe(0);
    expect(destroyed).toBe(true);
  });

  test("failed launch keeps picker open with concise status", () => {
    let destroyed = false;
    const state = pickerState({
      launchWeb: () => {
        throw new Error("spawn ENOENT");
      },
      renderer: {
        destroy: () => {
          destroyed = true;
        },
      } as PickerState["renderer"],
      list: {
        options: [
          {
            name: "Deploy · repo",
            description: "",
            value: { entry: { name: "deploy", source: "repo", file: "/r/deploy.yaml" } },
          },
        ],
        getSelectedIndex: () => 0,
        visible: true,
        flexGrow: 1,
      } as unknown as PickerState["list"],
      filter: { visible: true } as PickerState["filter"],
    });
    launchWorkbenchRoute(state, "import");
    expect(destroyed).toBe(false);
    expect(state.exit).toBeUndefined();
    expect(state.mode).toBe("list");
    expect(state.status.visible).toBe(true);
    expect(String(state.status.content)).toContain("workbench failed");
    expect(String(state.status.content)).toContain("spawn ENOENT");
    expect(String(state.footer.content).startsWith(LIST_HINT)).toBe(true);
    expect(String(state.footer.content)).toMatch(/1\/1$/);
    expect(String(state.footer.content)).toContain("enter run");
    expect(String(state.footer.content)).not.toMatch(/enter\/esc close/);
    expect(state.list.visible).toBe(true);
    expect(state.filter.visible).toBe(true);
    expect(selectedListEntry(state)?.name).toBe("deploy");
  });

  test("ctrl+e with empty list is a safe no-op; ctrl+o still imports", () => {
    const launched: LaunchWebRequest[] = [];
    let destroyed = false;
    const state = pickerState({
      launchWeb: (req) => launched.push(req),
      renderer: {
        destroy: () => {
          destroyed = true;
        },
      } as PickerState["renderer"],
      list: {
        options: [],
        getSelectedIndex: () => 0,
      } as unknown as PickerState["list"],
    });
    const edit = key("e", true);
    expect(tryListWorkbenchShortcut(state, edit)).toBe(true);
    expect(edit.defaultPrevented).toBe(true);
    expect(launched).toEqual([]);
    expect(state.exit).toBeUndefined();
    expect(destroyed).toBe(false);

    const imp = key("o", true);
    expect(tryListWorkbenchShortcut(state, imp)).toBe(true);
    expect(launched).toEqual([{ route: "import", repoRoot: "/repo" }]);
    expect(state.exit?.code).toBe(0);
  });

  test("shortcuts are list-mode only", () => {
    const launched: LaunchWebRequest[] = [];
    const state = pickerState({
      mode: "input",
      launchWeb: (req) => launched.push(req),
      list: {
        options: [
          {
            name: "Deploy · repo",
            description: "",
            value: { entry: { name: "deploy", source: "repo", file: "/r/deploy.yaml" } },
          },
        ],
        getSelectedIndex: () => 0,
      } as unknown as PickerState["list"],
    });
    const k = key("e", true);
    expect(tryListWorkbenchShortcut(state, k)).toBe(false);
    expect(k.defaultPrevented).toBe(false);
    expect(launched).toEqual([]);
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
  test("codeWatchTarget watches the executable for a compiled entry", () => {
    expect(codeWatchTarget("/$bunfs/root/cli", "/opt/herdr-workflows")).toEqual({
      path: "/opt/herdr-workflows",
      recursive: false,
    });
  });

  test("codeWatchTarget watches the source tree for a script entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-watch-target-"));
    dirs.push(root);
    const entry = join(root, "cli.ts");
    await writeFile(entry, "export {};\n");
    expect(codeWatchTarget(entry, "/runtime/bun")).toEqual({ path: root, recursive: true });
  });

  test("replacing the watched executable retires the workbench", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-retire-bin-"));
    dirs.push(root);
    const binary = join(root, "herdr-workflows");
    await writeFile(binary, "build-1");
    let retired = 0;
    const stop = retireOnCodeChange(() => retired++, { path: binary, recursive: false });
    await writeFile(binary, "build-2");
    expect(await waitFor(() => retired > 0)).toBe(true);
    stop();
  });

  test("a watched source tree retires on served sources only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-retire-src-"));
    dirs.push(root);
    await mkdir(join(root, "workflow"), { recursive: true });
    await writeFile(join(root, "cli.ts"), "export {};\n");
    let retired = 0;
    const stop = retireOnCodeChange(() => retired++, { path: root, recursive: true });
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
