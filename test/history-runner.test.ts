import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../src/config";
import { allocateRunId, getRunDetail, listRunHistory } from "../src/history/store";
import { runWorkflow } from "../src/run/runner";
import type { RunnerDeps } from "../src/run/context";

const dirs: string[] = [];
let prevState: string | undefined;

beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "hwf-hist-run-"));
  dirs.push(state);
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const baseConfig: WorkflowsConfig = {
  profiles: { claude: { kind: "claude" } },
  default_profile: "claude",
  transcripts: {},
};

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-hist-repo-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.yaml`), body);
  }
  return root;
}

function mockDeps(): Partial<RunnerDeps> {
  return {
    herdrCall: async () => ({ type: "ok" }),
    notificationShow: async () => undefined,
    agentStatus: async () => "idle",
    agentInfo: async () => ({}),
    paneClose: async () => undefined,
    tabClose: async () => undefined,
    reportToken: async () => undefined,
    transcriptText: async () => "",
    sleep: async () => undefined,
    now: () => Date.now(),
  };
}

describe("history runner lifecycle", () => {
  test("fast completion records every step", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - id: a
    run: [printf, one]
  - id: b
    run: [printf, two]
`,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
    });
    expect(result.ok).toBe(true);
    const listed = await listRunHistory({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.status).toBe("succeeded");
    const detail = await getRunDetail(listed.runs[0]!.id);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.map((s) => s.label)).toEqual(["a", "b"]);
  });

  test("failure before dispatch still finalizes", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
inputs:
  need:
    type: text
steps:
  - run: [printf, "{{inputs.need}}"]
`,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
    });
    expect(result.ok).toBe(false);
    const listed = await listRunHistory({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.status).toBe("failed");
    expect(listed.runs[0]?.progress).toBeUndefined();
  });

  test("nested workflow groups under parent and reports remaining", async () => {
    const root = await repoWith({
      child: `version: v1alpha1
steps:
  - id: inner
    run: [sh, -c, "exit 3"]
`,
      m: `version: v1alpha1
steps:
  - id: before
    run: [printf, first]
  - id: wrap
    workflow: child
  - id: after
    run: [printf, later]
`,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
    });
    expect(result.ok).toBe(false);
    const listed = await listRunHistory({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const detail = await getRunDetail(listed.runs[0]!.id);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.some((s) => s.workflow === "child")).toBe(true);
    expect(detail.steps.some((s) => s.label === "wrap" && s.outcome === "failed")).toBe(true);
    expect(detail.remaining).toBe(1);
    expect(detail.failure_explanation).toBeTruthy();
    expect(JSON.stringify(listed.runs[0])).not.toContain(detail.failure_explanation);
    const explained = detail.steps.filter((s) => s.explanation);
    expect(explained).toHaveLength(1);
    expect(explained[0]?.workflow).toBe("child");
    expect(detail.steps.find((s) => s.label === "wrap")?.explanation).toBeUndefined();
    // Ordinary preceding step must not steal nested children from the workflow wrapper.
    expect(detail.steps.map((s) => s.label)).toEqual(["before", "wrap", "inner"]);
    expect(detail.steps[1]?.action).toBe("workflow");
    expect(detail.steps[2]?.workflow).toBe("child");
    expect(detail.steps[2]?.parent_ordinal).toBe(2);
  });

  test("sequential workflow wrappers keep distinct child groups", async () => {
    const root = await repoWith({
      child1: `version: v1alpha1
steps:
  - id: inner1
    run: [printf, one]
`,
      child2: `version: v1alpha1
steps:
  - id: inner2
    run: [printf, two]
`,
      m: `version: v1alpha1
steps:
  - id: wrap1
    workflow: child1
  - id: wrap2
    workflow: child2
`,
    });
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
    });
    expect(result.ok).toBe(true);
    const listed = await listRunHistory({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const detail = await getRunDetail(listed.runs[0]!.id);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.map((s) => s.label)).toEqual(["wrap1", "inner1", "wrap2", "inner2"]);
    expect(detail.steps[1]?.parent_ordinal).toBe(1);
    expect(detail.steps[3]?.parent_ordinal).toBe(2);
  });

  test("snapshot collision rejects before steps", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const id = allocateRunId();
    const first = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
      runId: id,
    });
    expect(first.ok).toBe(true);
    const second = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
      runId: id,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already claimed/);
  });

  test("unavailable storage does not fail the workflow", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
    await mkdir(state, { recursive: true });
    await chmod(state, 0o755);
    const acks: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
      onHistoryAck: (line) => acks.push(line),
    });
    expect(result.ok).toBe(true);
    expect(acks.some((line) => line.includes("unavailable"))).toBe(true);
    const listed = await listRunHistory({ checkout_root: null });
    expect(listed.ok === false || (listed.ok && listed.runs.length === 0)).toBe(true);
  });

  test("checkout root is realpath-canonicalized", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const link = join(root, "..", `link-${Date.now()}`);
    dirs.push(link);
    await Bun.write(join(root, ".keep"), "");
    await symlink(root, link);
    const result = await runWorkflow({
      name: "m",
      repoRoot: link,
      config: baseConfig,
      ctx: { selection: "", cwd: link },
      deps: mockDeps(),
    });
    expect(result.ok).toBe(true);
    const listed = await listRunHistory({ checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.checkout_root).toBe(await realpath(root));
  });
});
