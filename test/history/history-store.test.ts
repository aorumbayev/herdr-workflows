import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { pluginStateDir, type WorkflowsConfig } from "../../src/context";
import { toListItem } from "../../src/history";
import {
  allocateRunId,
  runDetail,
  listRuns,
  readSnapshot,
  RunHistoryWriter,
  runsDir,
  snapshotPath,
} from "../../src/history";
import { RUN_HISTORY_RETENTION_BYTES } from "../../src/history";
import type { RunnerDeps } from "../../src/engine";
import { runWorkflow } from "../../src/engine";
import { assertCredentialStoreSafe } from "../../src/credentials";
import { writeTestSnapshot } from "../fakes/helpers/history-snapshot";

describe("run history store", () => {
  let stateDir: string;
  let checkoutRoot: string;
  let prevState: string | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "hwf-history-"));
    checkoutRoot = await mkdtemp(join(tmpdir(), "hwf-checkout-"));
    prevState = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
    await rm(stateDir, { recursive: true, force: true });
    await rm(checkoutRoot, { recursive: true, force: true });
  });

  function baseMeta(id?: string) {
    return {
      ...(id !== undefined ? { id } : {}),
      workflow: "demo",
      source: "repo" as const,
      checkout_root: checkoutRoot,
    };
  }

  test("exclusive claims reject reused identity", async () => {
    const id = allocateRunId();
    const a = new RunHistoryWriter();
    const b = new RunHistoryWriter();
    expect(await a.claim(baseMeta(id))).toMatchObject({ ok: true, state: "claimed", id });
    expect(await b.claim(baseMeta(id))).toMatchObject({ ok: false, state: "rejected", id });
    a.dispose();
    b.dispose();
  });

  test("concurrent runs own different snapshots", async () => {
    const a = new RunHistoryWriter();
    const b = new RunHistoryWriter();
    expect((await a.claim(baseMeta())).state).toBe("claimed");
    expect((await b.claim(baseMeta())).state).toBe("claimed");
    expect(a.id).not.toBe(b.id);
    a.dispose();
    b.dispose();
  });

  test("later write recovers complete state after missed intermediate", async () => {
    const writer = new RunHistoryWriter();
    expect((await writer.claim(baseMeta())).state).toBe("claimed");
    const id = writer.id!;
    await writer.setCurrentStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 2,
      action: "run",
      label: "one",
      started_at: new Date().toISOString(),
    });
    // Simulate a missed write by corrupting the on-disk file, then succeeding.
    await writeFile(snapshotPath(id), "{", { mode: 0o600 });
    await writer.recordStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 2,
      action: "run",
      label: "one",
      finished_at: new Date().toISOString(),
      outcome: "succeeded",
    });
    const snap = await readSnapshot(id);
    expect(snap?.steps).toHaveLength(1);
    expect(snap?.current_step).toBeUndefined();
    writer.dispose();
  });

  test("empty permissive state root is tightened and claimable", async () => {
    if (platform() === "win32") return;
    const writer = new RunHistoryWriter();
    await mkdir(stateDir, { recursive: true });
    await chmod(stateDir, 0o755);
    const result = await writer.claim(baseMeta());
    expect(result).toMatchObject({ ok: true, state: "claimed" });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    writer.dispose();
  });

  test("non-empty permissive state root makes history unavailable", async () => {
    if (platform() === "win32") return;
    const writer = new RunHistoryWriter();
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "marker"), "x");
    await chmod(stateDir, 0o755);
    const result = await writer.claim(baseMeta());
    expect(result).toMatchObject({ ok: true, state: "unavailable" });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
    writer.dispose();
  });

  test("history ACL validation refuses foreign grants without stripping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-acl-"));
    await mkdir(join(dir, "inner"), { recursive: true, mode: 0o700 });
    const target = join(dir, "inner");
    await expect(
      assertCredentialStoreSafe(target, {
        chmodFn: async () => undefined,
        stripAclFn: async () => undefined,
        readAclFn: async () => [{ principal: "user:other", allow: true }],
      }),
    ).rejects.toThrow(/foreign ACL/);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    await rm(dir, { recursive: true, force: true });
  });

  test("queued persists drain before finalize wins", async () => {
    const writer = new RunHistoryWriter();
    expect((await writer.claim(baseMeta())).state).toBe("claimed");
    const id = writer.id!;
    const started = new Date().toISOString();
    await Promise.all([
      writer.setCurrentStep({
        phase: "main",
        workflow: "demo",
        workflow_path: ["demo"],
        ordinal: 1,
        total: 1,
        action: "run",
        label: "one",
        started_at: started,
      }),
      writer.touch(),
      writer.recordStep({
        phase: "main",
        workflow: "demo",
        workflow_path: ["demo"],
        ordinal: 1,
        total: 1,
        action: "run",
        label: "one",
        finished_at: new Date().toISOString(),
        outcome: "succeeded",
      }),
    ]);
    await writer.finalize("succeeded");
    const snap = await readSnapshot(id);
    expect(snap?.status).toBe("succeeded");
    expect(snap?.steps).toHaveLength(1);
    expect(snap?.current_step).toBeUndefined();
    writer.dispose();
  });

  test("filters apply before forty-result limit", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (let i = 0; i < 45; i++) {
      const id = allocateRunId();
      const started = new Date(now - i * 1000).toISOString();
      await writeTestSnapshot({
        version: 1,
        id,
        workflow: "foreign",
        source: "repo",
        checkout_root: "/repo/other",
        started_at: started,
        heartbeat_at: started,
        finished_at: started,
        status: "succeeded",
        steps: [],
      });
    }
    const currentId = allocateRunId();
    const currentStarted = new Date(now - 50_000).toISOString();
    await writeTestSnapshot({
      version: 1,
      id: currentId,
      workflow: "mine",
      source: "repo",
      checkout_root: "/repo/a",
      started_at: currentStarted,
      heartbeat_at: currentStarted,
      finished_at: currentStarted,
      status: "succeeded",
      steps: [],
    });
    const listed = await listRuns({ checkout_root: "/repo/a", now });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.some((r) => r.id === currentId)).toBe(true);
    expect(listed.runs.length).toBeLessThanOrEqual(40);
  });

  test("retention preserves non-terminal and oversized newest terminal", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const active = new RunHistoryWriter();
    expect((await active.claim(baseMeta())).state).toBe("claimed");

    const pad = "x".repeat(200_000);
    for (let i = 0; i < 4; i++) {
      const id = allocateRunId();
      const started = new Date(Date.now() - (i + 1) * 10_000).toISOString();
      await writeTestSnapshot({
        version: 1,
        id,
        workflow: "old",
        title: pad,
        source: "repo",
        checkout_root: "/repo/a",
        started_at: started,
        heartbeat_at: started,
        finished_at: started,
        status: "succeeded",
        steps: [],
      });
    }
    const writer = new RunHistoryWriter();
    await writer.claim({ ...baseMeta(), workflow: "trigger" });
    await writer.finalize("succeeded");
    writer.dispose();

    const activeSnap = await readSnapshot(active.id!);
    expect(activeSnap?.status).toBeUndefined();

    const listed = await listRuns({ checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const terminalBytes = (
      await Promise.all(
        listed.runs
          .filter((r) => r.status !== "running" && r.status !== "stale")
          .map(async (r) => {
            try {
              return (await Bun.file(snapshotPath(r.id)).exists())
                ? (await import("node:fs/promises")).stat(snapshotPath(r.id)).then((s) => s.size)
                : 0;
            } catch {
              return 0;
            }
          }),
      )
    ).reduce((a, b) => a + b, 0);
    expect(terminalBytes).toBeLessThanOrEqual(RUN_HISTORY_RETENTION_BYTES * 2);
    active.dispose();
  });

  test("malformed snapshots are skipped", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(runsDir(), "not-a-uuid.json"), '{"version":1}\n', { mode: 0o600 });
    const nestedMissingParent = allocateRunId();
    const now = new Date().toISOString();
    await writeFile(
      snapshotPath(nestedMissingParent),
      `${JSON.stringify({
        version: 1,
        id: nestedMissingParent,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        finished_at: now,
        status: "succeeded",
        steps: [
          {
            phase: "main",
            workflow: "child",
            workflow_path: ["demo", "child"],
            ordinal: 1,
            total: 1,
            action: "run",
            label: "inner",
            finished_at: now,
            outcome: "succeeded",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const listed = await listRuns({ checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.every((r) => r.id !== nestedMissingParent)).toBe(true);
  });

  test("unsafe snapshot file ACL is unavailable not missing", async () => {
    if (platform() === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "hwf-acl-root-"));
    const writer = new RunHistoryWriter();
    expect((await writer.claim({ ...baseMeta(), checkout_root: root })).state).toBe("claimed");
    const id = writer.id!;
    await writer.finalize("succeeded");
    writer.dispose();
    await chmod(snapshotPath(id), 0o644);
    const { detail } = await runDetail(id);
    expect(detail.kind).toBe("unavailable");
    const listed = await listRuns({ checkout_root: null });
    expect(listed.ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("failed atomic replacement removes temporary snapshot", async () => {
    const writer = new RunHistoryWriter();
    expect((await writer.claim(baseMeta())).state).toBe("claimed");
    const id = writer.id!;
    const path = snapshotPath(id);
    await rm(path);
    await mkdir(path, { mode: 0o700 });
    await writer.touch();
    const leftovers = (await readdir(runsDir())).filter(
      (name) => name.startsWith(`.${id}.`) && name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
    writer.dispose();
    await rm(path, { recursive: true, force: true });
  });

  test("unresolvable claim checkout is unavailable", async () => {
    const writer = new RunHistoryWriter();
    const result = await writer.claim({
      ...baseMeta(),
      checkout_root: join(tmpdir(), `missing-${Date.now()}`),
    });
    expect(result).toMatchObject({ ok: true, state: "unavailable" });
    writer.dispose();
  });

  test("deleted checkout remains listable under soft canonical filter", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-soft-root-"));
    const canonical = await realpath(root);
    const writer = new RunHistoryWriter();
    expect((await writer.claim({ ...baseMeta(), checkout_root: root })).state).toBe("claimed");
    const id = writer.id!;
    await writer.finalize("succeeded");
    writer.dispose();
    const snap = await readSnapshot(id);
    expect(snap?.checkout_root).toBe(canonical);
    await rm(root, { recursive: true, force: true });
    const listed = await listRuns({ checkout_root: snap!.checkout_root });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.some((r) => r.id === id)).toBe(true);
  });

  test("search matches completed safe step labels", async () => {
    const writer = new RunHistoryWriter();
    await writer.claim(baseMeta());
    await writer.recordStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 1,
      action: "run",
      label: "unique-shell-label",
      finished_at: new Date().toISOString(),
      outcome: "succeeded",
    });
    await writer.finalize("succeeded");
    const listed = await listRuns({
      text: "unique-shell-label",
      checkout_root: checkoutRoot,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs).toHaveLength(1);
    expect(toListItem((await readSnapshot(writer.id!))!).step_labels).toContain(
      "unique-shell-label",
    );
    writer.dispose();
  });

  test("retention byte budget counts only terminal snapshots", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const active = new RunHistoryWriter();
    expect((await active.claim(baseMeta())).state).toBe("claimed");
    const huge = "y".repeat(400_000);
    await writeFile(
      snapshotPath(active.id!),
      `${JSON.stringify({
        version: 1,
        id: active.id,
        workflow: "demo",
        title: huge,
        source: "repo",
        checkout_root: "/repo/a",
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        steps: [],
      })}\n`,
      { mode: 0o600 },
    );
    const oldId = allocateRunId();
    const newId = allocateRunId();
    const oldStarted = new Date(Date.now() - 20_000).toISOString();
    const newStarted = new Date(Date.now() - 5_000).toISOString();
    await writeTestSnapshot({
      version: 1,
      id: oldId,
      workflow: "old",
      title: "z".repeat(300_000),
      source: "repo",
      checkout_root: "/repo/a",
      started_at: oldStarted,
      heartbeat_at: oldStarted,
      finished_at: oldStarted,
      status: "succeeded",
      steps: [],
    });
    await writeTestSnapshot({
      version: 1,
      id: newId,
      workflow: "new",
      title: "z".repeat(300_000),
      source: "repo",
      checkout_root: "/repo/a",
      started_at: newStarted,
      heartbeat_at: newStarted,
      finished_at: newStarted,
      status: "succeeded",
      steps: [],
    });
    const trigger = new RunHistoryWriter();
    await trigger.claim({ ...baseMeta(), workflow: "trigger" });
    await trigger.finalize("succeeded");
    trigger.dispose();
    expect(await readSnapshot(active.id!)).toBeDefined();
    expect(await readSnapshot(newId)).toBeDefined();
    expect(await readSnapshot(oldId)).toBeUndefined();
    active.dispose();
  });

  test("prior shared runs.jsonl is ignored and left unchanged", async () => {
    const priorPath = join(pluginStateDir(), "runs.jsonl");
    const body =
      [
        JSON.stringify({
          ts: "2020-01-01T00:00:00.000Z",
          run: "abcd1234",
          workflow: "old-log",
          ok: true,
        }),
        "{not json",
      ].join("\n") + "\n";
    await writeFile(priorPath, body, { mode: 0o600 });
    const all = await listRuns({ checkout_root: null });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.runs.every((r) => r.workflow !== "old-log")).toBe(true);
    expect(await Bun.file(priorPath).text()).toBe(body);
  });

  test("failure explanation is detail-only and not searchable", async () => {
    const writer = new RunHistoryWriter();
    await writer.claim(baseMeta());
    await writer.recordStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 1,
      action: "run",
      label: "boom",
      finished_at: new Date().toISOString(),
      outcome: "failed",
      failure: { action: "run", exit_code: 3 },
      explanation: "secret-token-xyz",
    });
    await writer.finalize("failed");
    const listed = await listRuns({ text: "secret-token-xyz", checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs).toHaveLength(0);
    const byExit = await listRuns({ text: "3", checkout_root: checkoutRoot });
    expect(byExit.ok).toBe(true);
    if (!byExit.ok) return;
    expect(byExit.runs).toHaveLength(1);
    const { detail } = await runDetail(writer.id!);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.failure_explanation).toBe("secret-token-xyz");
    expect(JSON.stringify(byExit.runs[0])).not.toContain("secret-token-xyz");
    writer.dispose();
  });
});

describe("history runner lifecycle", () => {
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
    const listed = await listRuns({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.status).toBe("succeeded");
    const { detail } = await runDetail(listed.runs[0]!.id);
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
    const listed = await listRuns({ checkout_root: await realpath(root) });
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
    const listed = await listRuns({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { detail } = await runDetail(listed.runs[0]!.id);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.some((s) => s.workflow === "child")).toBe(true);
    expect(detail.steps.some((s) => s.label === "wrap" && s.outcome === "failed")).toBe(true);
    expect(detail.remaining).toBe(1);
    expect(detail.failure_explanation).toBe("step 1: exit 3");
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
    const listed = await listRuns({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { detail } = await runDetail(listed.runs[0]!.id);
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
    await writeFile(join(state, "marker"), "x");
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
    const listed = await listRuns({ checkout_root: null });
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
    const listed = await listRuns({ checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.checkout_root).toBe(await realpath(root));
  });
});
