import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../src/config";
import { HerdrError } from "../src/herdr";
import { CAPTURE_BYTE_LIMIT, HWF_ENV_BYTE_LIMIT } from "../src/limits";
import { type RunnerDeps } from "../src/run/context";
import { runWorkflow } from "../src/run/runner";
import { runLogPath, type RunLogEntry } from "../src/runlog";

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

const baseConfig: WorkflowsConfig = {
  profiles: { claude: { kind: "claude" } },
  default_profile: "claude",
  transcripts: {},
};

function mockDeps(overrides: Partial<RunnerDeps> & { writeManagedResponse?: boolean } = {}): {
  deps: RunnerDeps;
  notes: string[];
  calls: { method: string; params: Record<string, unknown> }[];
  agents: Map<string, { status: string; pane_id: string; name: string }>;
} {
  const { writeManagedResponse = true, ...depOverrides } = overrides;
  const notes: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const agents = new Map<string, { status: string; pane_id: string; name: string }>();
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
        agents.set(name, { status: "idle", pane_id, name });
        return {
          type: "agent_started",
          agent: { name, pane_id, agent_status: "idle", agent: "claude" },
          argv: ["claude"],
        };
      }
      if (method === "agent.prompt") {
        const target = String(params.target);
        const info = agents.get(target) ?? {
          status: "idle",
          pane_id: target,
          name: target,
        };
        const text = String(params.text ?? "");
        const match = /absolute path ([^\s,]+)/.exec(text);
        if (writeManagedResponse && match?.[1]) {
          await mkdir(join(match[1]!, ".."), { recursive: true });
          await writeFile(match[1]!, "managed answer\n");
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
        };
        return {
          type: "agent_info",
          agent: {
            name: info.name,
            pane_id: info.pane_id,
            agent_status: info.status,
            agent: "claude",
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
      return { type: "ok", ...params };
    },
    notificationShow: async (title, body) => {
      notes.push(`${title}|${body ?? ""}`);
    },
    agentStatus: async (target) => agents.get(target)?.status ?? "idle",
    agentInfo: async (target) => {
      const info = agents.get(target) ?? { status: "idle", pane_id: "w1:p1", name: target };
      return {
        name: info.name,
        pane_id: info.pane_id,
        agent_status: info.status,
        agent: "claude",
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

  test("target mode keeps waiting for managed response until timeout", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: continue
    target: worker
    timeout: 200ms
`,
    });
    const { deps } = mockDeps({ writeManagedResponse: false });
    const clock = fastClock();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps: {
        ...deps,
        ...clock,
        agentStatus: async () => "idle",
        agentInfo: async () => ({
          name: "worker",
          pane_id: "w1:p9",
          agent_status: "idle",
          agent: "claude",
        }),
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
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
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
      new Bun.Glob("responses/*").scan({ cwd: state, absolute: true }),
    );
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
    let polls = 0;
    const { deps, notes } = mockDeps();
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      deps: {
        ...deps,
        ...fastClock(),
        agentStatus: async (target) => {
          polls += 1;
          if (polls <= 2) return "blocked";
          return deps.agentStatus(target);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(notes.filter((n) => n.includes("agent blocked"))).toHaveLength(1);
    const log = await readRunLog();
    expect(log.some((e) => e.blocked === true && e.ok === true)).toBe(true);
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
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps,
    });
    const err = failed(result);
    expect(err.coordinationLost).toBe(true);
    expect(err.error).toMatch(/may still be active/);
    expect(calls.filter((c) => c.method === "notification.show")).toHaveLength(0);
    const log = await readRunLog();
    expect(log.some((e) => e.interrupted)).toBe(true);
  });

  test("context.agent preflight fails when unavailable", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - agent: hi
    target: "{{context.agent}}"
`,
    });
    const { deps } = mockDeps({
      agentInfo: async () => {
        throw new Error("context.agent is unavailable: no named agent in pane w1:p1");
      },
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, paneId: "w1:p1" },
      deps,
    });
    const err = failed(result);
    expect(err.error).toMatch(/context\.agent|no named agent/);
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

  test("entry returns are recorded on the final run-log entry", async () => {
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
    const finals = (await readRunLog()).filter((e) => e.workflow === "m" && e.step === undefined);
    expect(finals[0]?.returns).toMatchObject({ note: "hello" });
    expect(typeof (finals[0]?.returns as { platform?: string }).platform).toBe("string");
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
    expect(lines).toEqual(["[1/2] go", "[2/2] skipme skip"]);
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
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root, workspaceId: "w1" },
      deps,
      onProgress: (_i, _n, label, outcome) => outcomes.push(`${label}:${outcome ?? "start"}`),
    });
    expect(result.ok).toBe(true);
    expect(outcomes.some((o) => o.includes("launch"))).toBe(true);
    const log = await readRunLog();
    expect(log.some((e) => e.launched)).toBe(true);
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
    const logText = await readFile(runLogPath(), "utf8");
    expect(logText).not.toContain("TRANSCRIPT");
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
