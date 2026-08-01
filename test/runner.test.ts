import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../src/config";
import { HerdrError, TRANSPORT_LOSS_CODES } from "../src/herdr";
import { CAPTURE_BYTE_LIMIT, HWF_ENV_BYTE_LIMIT } from "../src/limits";
import { AGENT_PROMPT_BYTE_LIMIT } from "../src/limits";
import { listRuns, loadAllSnapshots } from "../src/history/store";
import type { RunSnapshot } from "../src/history/types";
import type { RunnerDeps } from "../src/run/context";
import { runWorkflow } from "../src/run/runner";
import { fakeRunRecorder } from "./run-recorder-fake";

const dirs: string[] = [];
const prevStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "herdr-workflows-state-"));
  dirs.push(state);
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});
afterEach(async () => {
  if (prevStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevStateDir;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function readSnapshots(): Promise<RunSnapshot[]> {
  return loadAllSnapshots();
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

const baseConfig: WorkflowsConfig = {
  profiles: { claude: { kind: "claude" } },
  default_profile: "claude",
  transcripts: {},
};

type MockAgent = {
  status: string;
  pane_id: string;
  name: string;
  interactive_ready: boolean;
  launch_pending: boolean;
};

function mockDeps(overrides: Partial<RunnerDeps> & { writeManagedResponse?: boolean } = {}): {
  deps: RunnerDeps;
  notes: string[];
  calls: { method: string; params: Record<string, unknown> }[];
  agents: Map<string, MockAgent>;
} {
  const { writeManagedResponse = true, ...depOverrides } = overrides;
  const notes: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const agents = new Map<string, MockAgent>();
  const deps: RunnerDeps = {
    herdrCall: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "tab.create") {
        return {
          type: "tab_created",
          tab: { tab_id: "w1:t2", workspace_id: "w1" },
          root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
        };
      }
      if (method === "pane.split") {
        return {
          type: "pane_info",
          pane: { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1" },
        };
      }
      if (method === "layout.apply") {
        const root = params.root as Record<string, unknown>;
        if (root?.type === "split") {
          return {
            type: "layout_apply",
            layout: {
              tab_id: "w1:t1",
              workspace_id: "w1",
              focused_pane_id: "w1:p-run",
              root: {
                type: "split",
                second: { type: "pane", pane_id: "w1:p-run" },
              },
            },
          };
        }
        return {
          type: "layout_apply",
          layout: {
            tab_id: "w1:t2",
            workspace_id: "w1",
            focused_pane_id: "w1:p-run",
            root: { type: "pane", pane_id: "w1:p-run" },
          },
        };
      }
      if (method === "agent.start") {
        const name = String(params.name);
        const pane_id = String(params.pane_id);
        agents.set(name, {
          status: "idle",
          pane_id,
          name,
          interactive_ready: true,
          launch_pending: false,
        });
        return {
          type: "agent_started",
          agent: {
            name,
            pane_id,
            agent_status: "idle",
            agent: "claude",
            interactive_ready: true,
            launch_pending: false,
          },
          argv: ["claude"],
        };
      }
      if (method === "agent.prompt") {
        const target = String(params.target);
        const info = agents.get(target) ?? {
          status: "idle",
          pane_id: target,
          name: target,
          interactive_ready: true,
          launch_pending: false,
        };
        const text = String(params.text ?? "");
        let responsePath = /absolute path ([^\s,]+)/.exec(text)?.[1];
        if (responsePath?.endsWith("-prompt.txt")) {
          const spilled = await Bun.file(responsePath).text();
          const inner = /absolute path ([^\s,]+)/.exec(spilled)?.[1];
          if (inner && !inner.endsWith("-prompt.txt")) responsePath = inner;
        }
        if (writeManagedResponse && responsePath) {
          await mkdir(join(responsePath, ".."), { recursive: true });
          await writeFile(responsePath, "managed answer\n");
        }
        info.status = "done";
        agents.set(target, info);
        return {
          type: "agent_prompted",
          agent: { name: info.name, pane_id: info.pane_id, agent_status: "done" },
        };
      }
      if (method === "agent.get") {
        const target = String(params.target);
        const info = agents.get(target) ?? {
          status: "idle",
          pane_id: "w1:p1",
          name: "invoker",
          interactive_ready: true,
          launch_pending: false,
        };
        return {
          type: "agent_info",
          agent: {
            name: info.name,
            pane_id: info.pane_id,
            agent_status: info.status,
            agent: "claude",
            interactive_ready: info.interactive_ready,
            launch_pending: info.launch_pending,
          },
        };
      }
      if (method === "pane.wait_for_output") {
        return {
          type: "output_matched",
          pane_id: params.pane_id,
          matched_line: "ready",
          revision: 1,
          read: { text: "ready", pane_id: params.pane_id },
        };
      }
      if (method === "pane.close" || method === "tab.close" || method === "notification.show") {
        return { type: "ok" };
      }
      if (method === "pane.get") {
        return {
          type: "pane_info",
          pane: { pane_id: params.pane_id, tab_id: "w1:t1", workspace_id: "w1" },
        };
      }
      if (method === "pane.process_info") {
        const shellPid = 1001;
        return {
          type: "pane_process_info",
          process_info: {
            pane_id: params.pane_id,
            shell_pid: shellPid,
            foreground_process_group_id: shellPid,
            foreground_processes: [
              {
                pid: shellPid,
                name: "zsh",
                argv: ["zsh"],
                argv0: "zsh",
                cmdline: "zsh",
                cwd: "/",
              },
            ],
            tty: "/dev/ttys001",
          },
        };
      }
      return { type: "ok", ...params };
    },
    notificationShow: async (title, body) => {
      notes.push(`${title}|${body ?? ""}`);
    },
    agentStatus: async (target) => agents.get(target)?.status ?? "idle",
    agentInfo: async (target) => {
      const info = agents.get(target) ?? {
        status: "idle",
        pane_id: "w1:p1",
        name: target,
        interactive_ready: true,
        launch_pending: false,
      };
      return {
        name: info.name,
        pane_id: info.pane_id,
        agent_status: info.status,
        agent: "claude",
        interactive_ready: info.interactive_ready,
        launch_pending: info.launch_pending,
      };
    },
    paneClose: async () => undefined,
    tabClose: async () => undefined,
    reportToken: async () => undefined,
    transcriptText: async () => "TRANSCRIPT",
    sleep: async () => undefined,
    now: () => Date.now(),
    ...depOverrides,
  };
  return { deps, notes, calls, agents };
}

function fastClock(): { sleep: () => Promise<void>; now: () => number } {
  let t = 0;
  return {
    sleep: async () => undefined,
    now: () => {
      t += 50;
      return t;
    },
  };
}

function failed(
  result: Awaited<ReturnType<typeof runWorkflow>>,
): Extract<Awaited<ReturnType<typeof runWorkflow>>, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  return result;
}

describe("runner v1alpha1", () => {
  test("local argv result and explicit env handoff", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: probe
    run: [sh, -c, "printf hi; printf err >&2"]
  - id: next
    run: [sh, -c, 'printf "%s" "$MSG"']
    env: { MSG: "{{steps.probe.stdout}}" }
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("shell rejects reserved HWF_ env keys", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [echo, hi]
    env: { HWF_name: x }
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/reserved HWF_/);
  });

  test("native agent start then prompt order with managed response", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(true);
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf("pane.split")).toBeLessThan(methods.indexOf("agent.start"));
    expect(methods.indexOf("agent.start")).toBeLessThan(methods.indexOf("agent.prompt"));
    const split = calls.find((c) => c.method === "pane.split");
    expect(split?.params).toMatchObject({
      direction: "right",
      target_pane_id: "w1:p1",
    });
  });

  test("oversized managed prompts spill to a file; small ones submit directly", async () => {
    const small = "x".repeat(100);
    const large = "y".repeat(AGENT_PROMPT_BYTE_LIMIT + 64);
    const root = await repoWith({
      small: `version: v1alpha1
steps:
  - id: s
    agent: ${JSON.stringify(small)}
    using: claude
`,
      large: `version: v1alpha1
steps:
  - id: big
    agent: ${JSON.stringify(large)}
    using: claude
`,
    });
    const responseDir = join(process.env.HERDR_PLUGIN_STATE_DIR!, "responses");
    {
      const { deps, calls } = mockDeps();
      const result = await runWorkflow({
        name: "small",
        repoRoot: root,
        config: baseConfig,
        ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "w1:p1" },
        deps: { ...deps, ...fastClock(), responseDir },
      });
      expect(result.ok).toBe(true);
      const text = String(calls.find((c) => c.method === "agent.prompt")?.params.text ?? "");
      expect(text).toContain(small);
      expect(text).not.toMatch(/Read the absolute path/);
    }
    {
      const { deps, calls } = mockDeps();
      const result = await runWorkflow({
        name: "large",
        repoRoot: root,
        config: baseConfig,
        ctx: { selection: "", cwd: root, workspaceId: "w1", paneId: "w1:p1" },
        deps: { ...deps, ...fastClock(), responseDir },
      });
      expect(result.ok).toBe(true);
      const text = String(calls.find((c) => c.method === "agent.prompt")?.params.text ?? "");
      expect(text).toMatch(/Read the absolute path /);
      expect(text).not.toContain(large.slice(0, 80));
      const spillMatch = /Read the absolute path (\S+)/.exec(text);
      expect(spillMatch?.[1]).toBeTruthy();
      const spillPath = spillMatch![1]!;
      expect(spillPath).toContain("-prompt.txt");
      expect(await Bun.file(spillPath).exists()).toBe(false);
      const snaps = await readSnapshots();
      expect(snaps.some((s) => s.workflow === "large" && s.status === "succeeded")).toBe(true);
      expect(JSON.stringify(snaps)).not.toContain(large.slice(0, 80));
    }
  });

  test("new-agent retries agent_pane_busy once without creating a second pane", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: tab, workspace: w1 }
`,
    });
    const { deps, calls } = mockDeps();
    const baseCall = deps.herdrCall;
    let startAttempts = 0;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.start") {
            startAttempts += 1;
            if (startAttempts === 1) {
              calls.push({ method, params });
              throw new HerdrError(
                "agent_pane_busy",
                `agent target pane ${String(params.pane_id)} is not an available shell`,
              );
            }
          }
          return baseCall(method, params);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(startAttempts).toBe(2);
    expect(calls.filter((c) => c.method === "agent.start")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "tab.create")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "pane.split")).toHaveLength(0);
  });

  test("target mode never calls agent.start so agent_pane_busy is not retried", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: worker
`,
    });
    const { deps, calls, agents } = mockDeps();
    const baseCall = deps.herdrCall;
    agents.set("worker", {
      status: "idle",
      pane_id: "w1:p9",
      name: "worker",
      interactive_ready: true,
      launch_pending: false,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        agentInfo: async () => ({
          name: "worker",
          pane_id: "w1:p9",
          agent_status: "idle",
          agent: "claude",
        }),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.start") {
            throw new HerdrError(
              "agent_pane_busy",
              "agent target pane w1:p9 is not an available shell",
            );
          }
          return baseCall(method, params);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
  });

  test("new-agent fails fast when settled without managed response", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls } = mockDeps({ writeManagedResponse: false });
    const clock = fastClock();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...clock },
    });
    const err = failed(result);
    expect(err.error).toMatch(/managed response file was not written/);
    expect(err.error).not.toMatch(/within \d+s/);
    expect(calls.some((c) => c.method === "agent.prompt")).toBe(true);
  });

  test("new-agent fail-fasts after pickup if it settles without a managed response", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, agents } = mockDeps({ writeManagedResponse: false });
    const baseCall = deps.herdrCall;
    let polls = 0;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          const out = await baseCall(method, params);
          if (method === "agent.prompt") {
            const target = String(params.target);
            const info = agents.get(target);
            if (info) {
              info.status = "working";
              agents.set(target, info);
            }
            polls = 0;
          }
          return out;
        },
        agentStatus: async (target) => {
          const info = agents.get(target);
          if (!info) return "idle";
          polls += 1;
          if (polls > 3) {
            info.status = "done";
            agents.set(target, info);
          }
          return info.status;
        },
      },
    });
    const err = failed(result);
    expect(err.error).toMatch(/managed response file was not written/);
    expect(err.error).not.toMatch(/within \d+s/);
  });

  test("target mode keeps waiting for managed response until timeout", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: worker
    timeout: 200ms
`,
    });
    const { deps, agents, calls } = mockDeps({ writeManagedResponse: false });
    const baseCall = deps.herdrCall;
    agents.set("worker", {
      status: "idle",
      pane_id: "w1:p9",
      name: "worker",
      interactive_ready: true,
      launch_pending: false,
    });
    let polls = 0;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        agentInfo: async () => ({
          name: "worker",
          pane_id: "w1:p9",
          agent_status: "idle",
          agent: "claude",
        }),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.prompt") {
            agents.set("worker", {
              status: "working",
              pane_id: "w1:p9",
              name: "worker",
              interactive_ready: true,
              launch_pending: false,
            });
            polls = 0;
            calls.push({ method, params });
            return {
              type: "agent_prompted",
              agent: { name: "worker", pane_id: "w1:p9", agent_status: "working" },
            };
          }
          return baseCall(method, params);
        },
        agentStatus: async () => {
          polls += 1;
          if (polls > 3) return "idle";
          return agents.get("worker")?.status ?? "idle";
        },
      },
    });
    const err = failed(result);
    expect(err.error).toMatch(/did not settle with a managed response within 0\.2s/);
    expect(err.error).not.toMatch(/managed response file was not written/);
  });

  test("managed response file is cleaned up while step result keeps response", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
  - herdr: notification.show
    params: { title: kept, body: "{{steps.review.response}}" }
`,
    });
    const { deps, calls } = mockDeps();
    let responsePath = "";
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          const out = await deps.herdrCall(method, params);
          if (method === "agent.prompt") {
            const match = /absolute path ([^\s,]+)/.exec(String(params.text ?? ""));
            if (match?.[1]) responsePath = match[1]!;
            expect(responsePath).toContain(`${root}/.hwf/tmp/`);
            expect(await Bun.file(responsePath).exists()).toBe(true);
          }
          return out;
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(responsePath).not.toBe("");
    expect(await Bun.file(responsePath).exists()).toBe(false);
    const leftover = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: join(root, ".hwf", "tmp"), absolute: true }),
    ).catch(() => [] as string[]);
    expect(leftover).toEqual([]);
    const notify = calls.find((c) => c.method === "notification.show" && c.params.title === "kept");
    expect(notify?.params.body).toBe("managed answer\n");
  });

  test("blocked episode notifies once and is recorded in the run log", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    let prompted = false;
    let polls = 0;
    const { deps, notes } = mockDeps();
    const baseCall = deps.herdrCall;
    const recorder = fakeRunRecorder();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      recorder,
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.prompt") prompted = true;
          return baseCall(method, params);
        },
        agentStatus: async (target) => {
          if (!prompted) return "idle";
          polls += 1;
          if (polls <= 2) return "blocked";
          return deps.agentStatus(target);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(notes.filter((n) => n.includes("agent blocked"))).toHaveLength(1);
    expect(recorder.finishedCalls.some((c) => c.status === "succeeded")).toBe(true);
  });

  test("busy target rejected before prompt", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: worker
`,
    });
    const { deps, calls } = mockDeps({
      agentStatus: async () => "working",
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/herdr: agent\.prompt/);
    expect(calls.some((c) => c.method === "agent.prompt")).toBe(false);
  });

  test("when skip continues without recovery", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - id: flag
    run: [sh, -c, "printf ''"]
  - run: [sh, -c, "printf ran"]
    when: "{{steps.flag.stdout}}"
  - run: [sh, -c, "printf done"]
`,
    });
    const { deps, notes, calls } = mockDeps();
    const outcomes: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (_i, _n, label, outcome) => outcomes.push(`${label}:${outcome ?? "start"}`),
    });
    expect(result.ok).toBe(true);
    expect(outcomes.some((o) => o.includes("skip"))).toBe(true);
    expect(calls.some((c) => c.method === "notification.show")).toBe(false);
    expect(notes).toHaveLength(0);
  });

  test("continue_on_error suppresses recovery and leaves run failed", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - id: probe
    run: [sh, -c, "exit 2"]
    continue_on_error: true
  - run: [sh, -c, "printf ok"]
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.method === "notification.show")).toBe(false);
  });

  test("continue_on_error cannot tolerate command timeout", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - run: [sh, -c, "sleep 1"]
    timeout: 50ms
    continue_on_error: true
  - run: [sh, -c, "touch should-not-run"]
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(await Bun.file(join(root, "should-not-run")).exists()).toBe(false);
    expect(calls.some((c) => c.method === "notification.show")).toBe(true);
  });

  test("retry counts total attempts including the first", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [sh, -c, "test -f marker || (touch marker; exit 1)"]
    retry: { attempts: 2 }
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
  });

  test("on_failure runs once with context.error", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: "{{context.error.workflow}}", body: "{{context.error.message}}" }
steps:
  - run: [sh, -c, "printf boom >&2; exit 1"]
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    const notify = calls.filter((c) => c.method === "notification.show");
    expect(notify).toHaveLength(1);
    expect(notify[0]?.params).toMatchObject({ title: "m" });
  });

  test("agent failure details reach context.error.details in recovery", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.details.profile}}"
    body: "{{context.error.details.kind}}|{{context.error.details.pane_id}}|{{context.error.details.tab_id}}|{{context.error.details.workspace_id}}"
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls } = mockDeps({ writeManagedResponse: false });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(false);
    const notify = calls.filter((c) => c.method === "notification.show");
    expect(notify).toHaveLength(1);
    expect(notify[0]?.params).toMatchObject({
      title: "claude",
      body: "claude|w1:p3|w1:t1|w1",
    });
  });

  test("child failure bubbles to entry recovery with child attribution", async () => {
    const root = await repoWith({
      child: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: child-recovery }
steps:
  - id: boom
    run: [sh, -c, "exit 1"]
`,
      parent: `version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.workflow}}"
    body: "{{context.error.step_id}}"
steps:
  - workflow: child
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "parent",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(false);
    const notify = calls.filter((c) => c.method === "notification.show");
    expect(notify).toHaveLength(1);
    expect(notify[0]?.params).toMatchObject({ title: "child", body: "boom" });
  });

  test("transport loss skips on_failure", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: should-not-run }
steps:
  - herdr: notification.show
    params: { title: go }
`,
    });
    const { deps, calls } = mockDeps({
      herdrCall: async (method) => {
        if (method === "notification.show") {
          throw new HerdrError("closed", "notification.show: socket closed before response");
        }
        return { type: "ok" };
      },
    });
    const recorder = fakeRunRecorder();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
      recorder,
    });
    const err = failed(result);
    expect(err.coordinationLost).toBe(true);
    expect(err.error).toMatch(/may still be active/);
    expect(calls.filter((c) => c.method === "notification.show")).toHaveLength(0);
    expect(recorder.finishedCalls.some((c) => c.status === "interrupted")).toBe(true);
  });

  for (const code of TRANSPORT_LOSS_CODES) {
    test(`RunnerDeps transport-loss code ${code} is coordination loss`, async () => {
      const root = await repoWith({
        m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: should-not-run }
steps:
  - herdr: notification.show
    params: { title: go }
`,
      });
      const { deps, calls } = mockDeps({
        herdrCall: async (method) => {
          if (method === "notification.show") {
            throw new HerdrError(code, `${method}: injected ${code}`);
          }
          return { type: "ok" };
        },
      });
      const result = await runWorkflow({
        name: "m",
        repoRoot: root,
        config: baseConfig,
        ctx: { selection: "", cwd: root },
        deps,
        recorder: fakeRunRecorder(),
      });
      const err = failed(result);
      expect(err.coordinationLost).toBe(true);
      expect(err.error).toMatch(/may still be active/);
      expect(calls.filter((c) => c.method === "notification.show")).toHaveLength(0);
    });
  }

  test("port internal HerdrError is ordinary failure and on_failure runs", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - herdr: notification.show
    params: { title: go }
`,
    });
    const base = mockDeps();
    let attempts = 0;
    const deps: RunnerDeps = {
      ...base.deps,
      herdrCall: async (method, params = {}) => {
        if (method === "notification.show" && attempts++ === 0) {
          throw new HerdrError("internal", "simulated plain Error from port");
        }
        return base.deps.herdrCall(method, params);
      },
    };
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
      recorder: fakeRunRecorder(),
    });
    expect(result.ok).toBe(false);
    expect(failed(result).coordinationLost).toBeUndefined();
    const notify = base.calls.filter((c) => c.method === "notification.show");
    expect(notify).toHaveLength(1);
    expect(notify[0]?.params).toMatchObject({ title: "recovered" });
  });

  test("context.agent uses pane id when the detected agent has a null name", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: "{{context.agent}}"
`,
    });
    const { deps, calls, agents } = mockDeps();
    agents.set("w2T:p1", {
      status: "idle",
      pane_id: "w2T:p1",
      name: "",
      interactive_ready: true,
      launch_pending: false,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w2T:p1" },
      deps: {
        ...deps,
        agentInfo: async () => ({
          name: null,
          pane_id: "w2T:p1",
          agent_status: agents.get("w2T:p1")?.status ?? "idle",
          agent: "claude",
        }),
      },
    });
    expect(result.ok).toBe(true);
    const prompt = calls.find((c) => c.method === "agent.prompt");
    expect(prompt?.params.target).toBe("w2T:p1");
  });

  test("context.agent prefers the live name over the pane id", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: "{{context.agent}}"
`,
    });
    const { deps, calls, agents } = mockDeps();
    agents.set("reviewer", {
      status: "idle",
      pane_id: "w2T:p1",
      name: "reviewer",
      interactive_ready: true,
      launch_pending: false,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w2T:p1" },
      deps: {
        ...deps,
        agentInfo: async () => ({
          name: "reviewer",
          pane_id: "w2T:p1",
          agent_status: agents.get("reviewer")?.status ?? "idle",
          agent: "claude",
        }),
      },
    });
    expect(result.ok).toBe(true);
    const prompt = calls.find((c) => c.method === "agent.prompt");
    expect(prompt?.params.target).toBe("reviewer");
  });

  test("context.agent preflight fails when the pane has no recognized agent", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: hi
    target: "{{context.agent}}"
`,
    });
    const { deps } = mockDeps({
      agentInfo: async () => ({
        name: null,
        pane_id: "w1:p1",
        agent_status: null,
        agent: null,
      }),
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/no recognized agent in this pane/);
    expect(err.error).toMatch(/run this from a pane running a recognized agent/);
  });

  test("target-mode step prompts the pane id from a null-named context.agent", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: distill
    target: "{{context.agent}}"
`,
    });
    const { deps, calls, agents } = mockDeps();
    agents.set("w2V:p1", {
      status: "idle",
      pane_id: "w2V:p1",
      name: "",
      interactive_ready: true,
      launch_pending: false,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w2V:p1" },
      deps: {
        ...deps,
        agentInfo: async () => ({
          name: null,
          pane_id: "w2V:p1",
          agent_status: agents.get("w2V:p1")?.status ?? "idle",
          agent: "claude",
        }),
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.method === "agent.start")).toBe(false);
    expect(calls.find((c) => c.method === "agent.prompt")?.params).toMatchObject({
      target: "w2V:p1",
    });
  });

  test("readiness uses pane.wait_for_output defaults", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: boot
    run: [sh, -c, "printf ready"]
    pane: { open: tab }
    ready_when: "/ready/"
    timeout: 5s
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps,
    });
    expect(result.ok).toBe(true);
    const wait = calls.find((c) => c.method === "pane.wait_for_output");
    expect(wait?.params).toMatchObject({
      source: "recent",
      lines: 80,
      strip_ansi: true,
      match: { type: "regex", value: "ready" },
      timeout_ms: 5000,
    });
  });

  test("beside placed run splits and send_input without layout.apply", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: boot
    run: [sh, -c, "echo LISTENING"]
    pane: { open: beside, target: "w1:pM" }
    ready_when: "/LISTENING/"
    timeout: 5s
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.method === "layout.apply")).toBe(false);
    const split = calls.find((c) => c.method === "pane.split");
    const send = calls.find((c) => c.method === "pane.send_input");
    expect(split?.params).toMatchObject({ direction: "right", target_pane_id: "w1:pM" });
    expect(send?.params).toMatchObject({ pane_id: "w1:p3", keys: ["Enter"] });
  });

  test("entry returns are recorded on the private snapshot", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
returns:
  note: "{{steps.echo.stdout}}"
  platform: "{{context.platform}}"
steps:
  - id: echo
    run: [printf, hello]
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    expect(result.ok).toBe(true);
    const snaps = (await readSnapshots()).filter((s) => s.workflow === "m");
    expect(snaps[0]?.returns).toMatchObject({ note: "hello" });
    expect(typeof (snaps[0]?.returns as { platform?: string } | undefined)?.platform).toBe(
      "string",
    );
    const listed = await listRuns({ checkout_root: root });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(JSON.stringify(listed.runs)).not.toContain("hello");
  });

  test("progress reports one outcome line per step including skip", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
inputs:
  flag:
    type: text
    default: ""
steps:
  - id: go
    run: [printf, ok]
  - id: skipme
    run: [printf, no]
    when: "{{inputs.flag}}"
`,
    });
    const { deps } = mockDeps();
    const lines: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (i, n, label, outcome = "ok") => {
        lines.push(`[${i}/${n}] ${label}${outcome === "ok" ? "" : ` ${outcome}`}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(lines).toEqual(["[1/2] go start", "[1/2] go", "[2/2] skipme skip"]);
  });

  test("CLI progress emits both start and outcome exactly once per step", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [sh, -c, "printf a"]
  - run: [sh, -c, "printf b"]
`,
    });
    const { deps } = mockDeps();
    const events: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
      onProgress: (i, n, label, outcome = "ok") => {
        events.push(`${i}/${n}:${label}:${outcome}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      "1/2:run: sh -c printf a:start",
      "1/2:run: sh -c printf a:ok",
      "2/2:run: sh -c printf b:start",
      "2/2:run: sh -c printf b:ok",
    ]);
  });

  test("background placed run launches without a result", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: serve
    run: [sh, -c, "sleep 100"]
    background: true
    pane: { open: tab }
  - run: [sh, -c, "printf next"]
`,
    });
    const { deps } = mockDeps();
    const outcomes: string[] = [];
    const recorder = fakeRunRecorder();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
      recorder,
      onProgress: (_i, _n, label, outcome) => outcomes.push(`${label}:${outcome ?? "start"}`),
    });
    expect(result.ok).toBe(true);
    expect(outcomes.some((o) => o.includes("launch"))).toBe(true);
    expect(recorder.stepFinishedCalls.some((c) => c.outcomeKind === "launched")).toBe(true);
  });

  test("transcript file is cleaned up and never logged", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: "see {{context.transcript}}"
    using: claude
`,
    });
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(true);
    const leftover = await Array.fromAsync(
      new Bun.Glob("transcripts/*").scan({ cwd: state, absolute: true }),
    );
    expect(leftover).toEqual([]);
    const snaps = await readSnapshots();
    expect(JSON.stringify(snaps)).not.toContain("TRANSCRIPT");
  });

  test("failed run keeps the managed response and still removes the transcript", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: brief
    agent: "see {{context.transcript}}"
    using: claude
  - run: [sh, -c, "exit 3"]
`,
    });
    const scratch = join(root, ".hwf", "tmp");
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(false);
    const kept = await Array.fromAsync(
      new Bun.Glob("*-step-1.txt").scan({ cwd: scratch, absolute: true }),
    );
    expect(kept).toHaveLength(1);
    expect(await Bun.file(kept[0]!).text()).toBe("managed answer\n");
    const transcripts = await Array.fromAsync(new Bun.Glob("*-transcript.txt").scan(scratch));
    expect(transcripts).toEqual([]);
  });

  test("successful run removes the managed response and the transcript", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: brief
    agent: "see {{context.transcript}}"
    using: claude
`,
    });
    const scratch = join(root, ".hwf", "tmp");
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(true);
    const leftover = await Array.fromAsync(new Bun.Glob("*.txt").scan(scratch));
    expect(leftover).toEqual([]);
  });

  test("recovery reads the transcript file before cleanup removes it", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
on_failure:
  run: [test, -f, "{{context.transcript_file}}"]
steps:
  - agent: "see {{context.transcript}}"
    using: claude
  - run: [sh, -c, "exit 3"]
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(failed(result).error).not.toContain("on_failure failed");
  });

  test("close always closes the pane when agent.start fails after placement", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside, close: always }
`,
    });
    const { deps, calls } = mockDeps();
    const baseCall = deps.herdrCall;
    const closed: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.start") {
            throw new HerdrError("agent_start_failed", "simulated start failure");
          }
          return baseCall(method, params);
        },
        paneClose: async (paneId) => {
          closed.push(paneId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(closed).toEqual(["w1:p3"]);
    expect(calls.filter((c) => c.method === "pane.split")).toHaveLength(1);
  });

  test("close success leaves the pane open when agent.start fails after placement", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside, close: success }
`,
    });
    const { deps } = mockDeps();
    const baseCall = deps.herdrCall;
    const closed: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.start") {
            throw new HerdrError("agent_start_failed", "simulated start failure");
          }
          return baseCall(method, params);
        },
        paneClose: async (paneId) => {
          closed.push(paneId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(closed).toEqual([]);
  });

  test("stalled agent.prompt gets exactly one enter nudge then completes", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: |
      line one
      line two
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls, agents } = mockDeps({ writeManagedResponse: false });
    const baseCall = deps.herdrCall;
    let status = "idle";
    let pendingPath: string | undefined;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.prompt") {
            const text = String(params.text ?? "");
            pendingPath = /absolute path ([^\s,]+)/.exec(text)?.[1];
            const target = String(params.target);
            const info = agents.get(target) ?? {
              status: "idle",
              pane_id: "w1:p3",
              name: target,
              interactive_ready: true,
              launch_pending: false,
            };
            agents.set(target, { ...info, status: "idle" });
            calls.push({ method, params });
            return {
              type: "agent_prompted",
              agent: { name: target, pane_id: info.pane_id, agent_status: "idle" },
            };
          }
          if (method === "agent.send_keys") {
            calls.push({ method, params });
            expect(params.keys).toEqual(["enter"]);
            if (pendingPath) {
              await mkdir(join(pendingPath, ".."), { recursive: true });
              await writeFile(pendingPath, "nudged answer\n");
            }
            status = "done";
            const target = String(params.target);
            const info = agents.get(target);
            if (info) {
              info.status = "done";
              agents.set(target, info);
            }
            return { type: "ok" };
          }
          return baseCall(method, params);
        },
        agentStatus: async () => status,
      },
    });
    expect(result.ok).toBe(true);
    const enters = calls.filter(
      (c) =>
        c.method === "agent.send_keys" &&
        Array.isArray(c.params.keys) &&
        c.params.keys[0] === "enter",
    );
    expect(enters).toHaveLength(1);
  });

  test("agent.prompt that starts working immediately gets no enter nudge", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: |
      line one
      line two
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "agent.send_keys")).toHaveLength(0);
  });

  test("cold agent that ignores the first prompt gets exactly one re-submit", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls, agents } = mockDeps({ writeManagedResponse: false });
    const baseCall = deps.herdrCall;
    let prompts = 0;
    let pendingPath: string | undefined;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.prompt") {
            prompts += 1;
            const text = String(params.text ?? "");
            pendingPath = /absolute path ([^\s,]+)/.exec(text)?.[1];
            const target = String(params.target);
            const info = agents.get(target) ?? {
              status: "idle",
              pane_id: "w1:p3",
              name: target,
              interactive_ready: true,
              launch_pending: false,
            };
            if (prompts >= 2) {
              if (pendingPath) {
                await mkdir(join(pendingPath, ".."), { recursive: true });
                await writeFile(pendingPath, "second try\n");
              }
              agents.set(target, { ...info, status: "done" });
            } else {
              agents.set(target, { ...info, status: "idle" });
            }
            calls.push({ method, params });
            return {
              type: "agent_prompted",
              agent: {
                name: target,
                pane_id: info.pane_id,
                agent_status: prompts >= 2 ? "working" : "idle",
              },
            };
          }
          if (method === "agent.send_keys") {
            calls.push({ method, params });
            return { type: "ok" };
          }
          if (method === "tab.create" || method === "pane.split") {
            const out = await baseCall(method, params);
            return out;
          }
          return baseCall(method, params);
        },
        agentStatus: async (target) => agents.get(target)?.status ?? "idle",
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "agent.prompt")).toHaveLength(2);
    expect(
      calls.filter((c) => c.method === "tab.create" || c.method === "pane.split"),
    ).toHaveLength(1);
  });

  test("agent that goes working after the first prompt is not re-submitted", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: { ...deps, ...fastClock() },
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "agent.send_keys")).toHaveLength(0);
  });

  test("exhausted prompt attempts fail naming the stalled submission", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
    timeout: 200ms
`,
    });
    const { deps, calls } = mockDeps({ writeManagedResponse: false });
    const baseCall = deps.herdrCall;
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        herdrCall: async (method, params = {}) => {
          if (method === "agent.prompt") {
            calls.push({ method, params });
            return {
              type: "agent_prompted",
              agent: { name: String(params.target), pane_id: "w1:p3", agent_status: "idle" },
            };
          }
          if (method === "agent.send_keys") {
            calls.push({ method, params });
            return { type: "ok" };
          }
          return baseCall(method, params);
        },
        agentStatus: async () => "idle",
      },
    });
    const err = failed(result);
    expect(err.error).toMatch(/was not accepted after 3 attempts/);
    expect(err.error).toMatch(/never left idle/);
    expect(calls.filter((c) => c.method === "agent.prompt")).toHaveLength(3);
  });

  test("templated herdr enum param fails at runtime on a bad resolved value", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
inputs:
  d: text
steps:
  - herdr: pane.split
    params:
      direction: "{{inputs.d}}"
      target_pane_id: w1:p1
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      inputs: { d: "sideways" },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/param 'direction' must be one of right, down/);
    expect(calls.filter((c) => c.method === "pane.split")).toHaveLength(0);
  });

  test("templated herdr enum param succeeds at runtime on a good resolved value", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
inputs:
  d: text
steps:
  - herdr: pane.split
    params:
      direction: "{{inputs.d}}"
      target_pane_id: w1:p1
`,
    });
    const { deps, calls } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      inputs: { d: "right" },
      deps,
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "pane.split")).toHaveLength(1);
    expect(calls.find((c) => c.method === "pane.split")?.params).toMatchObject({
      direction: "right",
      target_pane_id: "w1:p1",
    });
  });

  test("HWF environment cap fails preflight", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
inputs:
  blob: text
steps:
  - run: [echo, "{{inputs.blob}}"]
`,
    });
    const { deps } = mockDeps();
    const blob = "x".repeat(HWF_ENV_BYTE_LIMIT);
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      inputs: { blob },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/HWF environment/);
  });

  test("child HWF environment cap fails before child step 1", async () => {
    const half = "x".repeat(Math.floor(HWF_ENV_BYTE_LIMIT / 2));
    const root = await repoWith({
      child: `version: v1alpha1
inputs:
  a: text
  b: text
steps:
  - run: [echo, "{{inputs.a}}", "{{inputs.b}}"]
`,
      parent: `version: v1alpha1
inputs:
  a: text
steps:
  - workflow: child
    inputs:
      a: "{{inputs.a}}"
      b: "{{inputs.a}}"
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "parent",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      inputs: { a: half },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/HWF environment/);
  });

  test("detached resolveDynamic false requires domain snapshots", async () => {
    const root = await repoWith({
      dyn: `version: v1alpha1
inputs:
  branch:
    type: choice
    options:
      run: [printf, main]
steps:
  - run: [echo, "{{inputs.branch}}"]
`,
    });
    const { deps } = mockDeps();
    const missing = await runWorkflow({
      name: "dyn",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      inputs: { branch: "main" },
      resolveDynamic: false,
      deps,
    });
    expect(failed(missing).error).toMatch(/missing launch payload domain snapshot/);

    const ok = await runWorkflow({
      name: "dyn",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      inputs: { branch: "main" },
      domains: { branch: ["main"] },
      resolveDynamic: false,
      deps,
    });
    expect(ok.ok).toBe(true);
  });

  test("command capture cap terminates and fails", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [sh, -c, "python3 -c 'print(\\"x\\" * ${CAPTURE_BYTE_LIMIT + 10})'"]
`,
    });
    const { deps } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/command output|byte limit/);
  });
});
