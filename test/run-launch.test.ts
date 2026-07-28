import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationContext } from "../src/config";
import { runLogPath, type RunLogEntry } from "../src/runlog";
import type { PickerState } from "../src/tui/picker";
import { startRun } from "../src/tui/picker";
import {
  buildInvocationEnv,
  buildRunArgs,
  launchDetachedRun,
  selfRunArgv,
  type DetachedRunHandle,
  type LaunchRunRequest,
} from "../src/tui/run-launch";
import type { LoadedWorkflow } from "../src/workflow/types";

const dirs: string[] = [];
const prevState = process.env.HERDR_PLUGIN_STATE_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
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
        needsInvokingAgent: false,
      }) satisfies LoadedWorkflow,
    renderer: { destroy: () => undefined },
    filter: { visible: true },
    list: { visible: true, flexGrow: 1 },
    status: { visible: false, flexGrow: 0, content: "" },
    invalid: { visible: false },
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
  test("selfRunArgv and buildRunArgs shape the detached child", () => {
    expect(buildRunArgs("sleep", { focus: "x" }, "hi")).toEqual([
      "sleep",
      "--input",
      "focus=x",
      "--prompt",
      "hi",
    ]);
    const argv = selfRunArgv(["sleep"]);
    expect(argv.at(-2)).toBe("run");
    expect(argv.at(-1)).toBe("sleep");
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
    const running = startRun(
      state,
      { name: "sleepy", source: "repo", file: "/repo/.hwf/workflows/sleepy.yaml" },
      "",
    );
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
    await startRun(
      state,
      { name: "quick", source: "repo", file: "/repo/.hwf/workflows/quick.yaml" },
      "",
    );
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
    await startRun(
      state,
      { name: "quick", source: "repo", file: "/repo/.hwf/workflows/quick.yaml" },
      "",
    );
    expect(state.progressLines.some((line) => line.includes("[1/1]"))).toBe(true);
    expect(state.exit?.code).toBe(0);
    expect(destroyed).toBe(true);
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
      prompt: "",
      onProgressLine: () => undefined,
      spawn: ((_argv, opts) =>
        Bun.spawn([process.execPath, script], {
          cwd: typeof opts?.cwd === "string" ? opts.cwd : root,
          env: opts?.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })) as typeof Bun.spawn,
    });

    await Bun.sleep(80);
    handle.detach();
    const result = await handle.result;
    expect(result.ok).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(true);
    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(env.pane).toBe("wLive:p1");
    expect(env.tab).toBe("wLive:t1");
    expect(env.workspace).toBe("wLive");
    expect(env.repo).toBe(root);
  });
});
