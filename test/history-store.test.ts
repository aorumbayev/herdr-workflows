import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import {
  allocateRunId,
  getRunDetail,
  listRunHistory,
  readSnapshot,
  replaceSnapshotForTest,
  RunHistorySession,
  runsDir,
  snapshotPath,
} from "../src/history/store";
import {
  RUN_HISTORY_RETENTION_BYTES,
  RUN_HISTORY_STALE_MS,
  type RunSnapshot,
} from "../src/history/types";
import { isSnapshot } from "../src/history/validate";
import { projectStatus, toDetail, toListItem } from "../src/history/project";
import { pluginStateDir } from "../src/config";
import { assertCredentialStoreSafe } from "../src/web/credential-store";

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

describe("run history store", () => {
  test("exclusive claims reject reused identity", async () => {
    const id = allocateRunId();
    const a = new RunHistorySession();
    const b = new RunHistorySession();
    expect(await a.claim(baseMeta(id))).toMatchObject({ ok: true, state: "claimed", id });
    expect(await b.claim(baseMeta(id))).toMatchObject({ ok: false, state: "rejected", id });
    a.dispose();
    b.dispose();
  });

  test("concurrent runs own different snapshots", async () => {
    const a = new RunHistorySession();
    const b = new RunHistorySession();
    expect((await a.claim(baseMeta())).state).toBe("claimed");
    expect((await b.claim(baseMeta())).state).toBe("claimed");
    expect(a.id).not.toBe(b.id);
    a.dispose();
    b.dispose();
  });

  test("later write recovers complete state after missed intermediate", async () => {
    const session = new RunHistorySession();
    expect((await session.claim(baseMeta())).state).toBe("claimed");
    const id = session.id!;
    await session.setCurrentStep({
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
    await session.recordStep({
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
    session.dispose();
  });

  test("unsafe ACL makes history unavailable without changing permissions", async () => {
    if (platform() === "win32") return;
    const session = new RunHistorySession();
    await mkdir(stateDir, { recursive: true });
    await chmod(stateDir, 0o755);
    const result = await session.claim(baseMeta());
    expect(result).toMatchObject({ ok: true, state: "unavailable" });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
    session.dispose();
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
    const session = new RunHistorySession();
    expect((await session.claim(baseMeta())).state).toBe("claimed");
    const id = session.id!;
    const started = new Date().toISOString();
    await Promise.all([
      session.setCurrentStep({
        phase: "main",
        workflow: "demo",
        workflow_path: ["demo"],
        ordinal: 1,
        total: 1,
        action: "run",
        label: "one",
        started_at: started,
      }),
      session.touch(),
      session.recordStep({
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
    await session.finalize("succeeded");
    const snap = await readSnapshot(id);
    expect(snap?.status).toBe("succeeded");
    expect(snap?.steps).toHaveLength(1);
    expect(snap?.current_step).toBeUndefined();
    session.dispose();
  });

  test("heartbeat boundaries project running then stale then running", async () => {
    const started = new Date(Date.now() - 1_000).toISOString();
    const snap: RunSnapshot = {
      version: 1,
      id: allocateRunId(),
      workflow: "demo",
      source: "repo",
      checkout_root: "/repo/a",
      started_at: started,
      heartbeat_at: started,
      steps: [],
    };
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    await replaceSnapshotForTest(snap);
    expect(projectStatus(snap, Date.parse(started) + 1_000)).toBe("running");
    expect(projectStatus(snap, Date.parse(started) + RUN_HISTORY_STALE_MS)).toBe("stale");
    const fresh = { ...snap, heartbeat_at: new Date().toISOString() };
    expect(projectStatus(fresh, Date.now())).toBe("running");
  });

  test("terminal status precedes heartbeat age", async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const snap: RunSnapshot = {
      version: 1,
      id: allocateRunId(),
      workflow: "demo",
      source: "repo",
      checkout_root: "/repo/a",
      started_at: old,
      heartbeat_at: old,
      finished_at: old,
      status: "succeeded",
      steps: [],
    };
    expect(projectStatus(snap, Date.now())).toBe("succeeded");
  });

  test("filters apply before forty-result limit", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (let i = 0; i < 45; i++) {
      const id = allocateRunId();
      const started = new Date(now - i * 1000).toISOString();
      await replaceSnapshotForTest({
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
    await replaceSnapshotForTest({
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
    const listed = await listRunHistory({ checkout_root: "/repo/a", now });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.some((r) => r.id === currentId)).toBe(true);
    expect(listed.runs.length).toBeLessThanOrEqual(40);
  });

  test("retention preserves non-terminal and oversized newest terminal", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const active = new RunHistorySession();
    expect((await active.claim(baseMeta())).state).toBe("claimed");

    const pad = "x".repeat(200_000);
    for (let i = 0; i < 4; i++) {
      const id = allocateRunId();
      const started = new Date(Date.now() - (i + 1) * 10_000).toISOString();
      await replaceSnapshotForTest({
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
    const session = new RunHistorySession();
    await session.claim({ ...baseMeta(), workflow: "trigger" });
    await session.finalize("succeeded");
    session.dispose();

    const activeSnap = await readSnapshot(active.id!);
    expect(activeSnap?.status).toBeUndefined();

    const listed = await listRunHistory({ checkout_root: null });
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
    const listed = await listRunHistory({ checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.every((r) => r.id !== nestedMissingParent)).toBe(true);
  });

  test("malformed nested step fields are rejected by guard", () => {
    const id = allocateRunId();
    const now = new Date().toISOString();
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        steps: [{ label: "broken" }],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: "not-a-date",
        heartbeat_at: now,
        steps: [],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        status: "succeeded",
        steps: [],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        finished_at: now,
        status: "succeeded",
        current_step: {
          phase: "main",
          workflow: "demo",
          workflow_path: ["demo"],
          ordinal: 1,
          total: 1,
          action: "run",
          label: "x",
          started_at: now,
        },
        steps: [],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        steps: [
          {
            phase: "main",
            workflow: "demo",
            workflow_path: ["demo"],
            ordinal: 0,
            total: 1,
            action: "run",
            label: "x",
            finished_at: now,
            outcome: "succeeded",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
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
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
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
            workflow: "demo",
            workflow_path: ["demo"],
            ordinal: 1,
            total: 1,
            parent_ordinal: 1,
            action: "run",
            label: "top",
            finished_at: now,
            outcome: "succeeded",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        version: 1,
        id,
        workflow: "demo",
        source: "repo",
        checkout_root: "/repo/a",
        started_at: now,
        heartbeat_at: now,
        current_step: {
          phase: "main",
          workflow: "child",
          workflow_path: ["demo", "child"],
          ordinal: 1,
          total: 1,
          action: "run",
          label: "inner",
          started_at: now,
        },
        steps: [],
      }),
    ).toBe(false);
  });

  test("projection groups nested steps only by parent_ordinal", async () => {
    const id = allocateRunId();
    const now = new Date().toISOString();
    const snap: RunSnapshot = {
      version: 1,
      id,
      workflow: "m",
      source: "repo",
      checkout_root: "/repo/a",
      started_at: now,
      heartbeat_at: now,
      finished_at: now,
      status: "succeeded",
      steps: [
        {
          phase: "main",
          workflow: "child1",
          workflow_path: ["m", "child1"],
          ordinal: 1,
          total: 1,
          parent_ordinal: 1,
          action: "run",
          label: "inner1",
          finished_at: now,
          outcome: "succeeded",
        },
        {
          phase: "main",
          workflow: "m",
          workflow_path: ["m"],
          ordinal: 1,
          total: 2,
          action: "workflow",
          label: "wrap1",
          finished_at: now,
          outcome: "succeeded",
        },
        {
          phase: "main",
          workflow: "child2",
          workflow_path: ["m", "child2"],
          ordinal: 1,
          total: 1,
          parent_ordinal: 2,
          action: "run",
          label: "inner2",
          finished_at: now,
          outcome: "succeeded",
        },
        {
          phase: "main",
          workflow: "m",
          workflow_path: ["m"],
          ordinal: 2,
          total: 2,
          action: "workflow",
          label: "wrap2",
          finished_at: now,
          outcome: "succeeded",
        },
      ],
    };
    expect(isSnapshot(snap)).toBe(true);
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    await replaceSnapshotForTest(snap);
    const detail = toDetail(snap);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.map((s) => s.label)).toEqual(["wrap1", "inner1", "wrap2", "inner2"]);
  });

  test("unsafe snapshot file ACL is unavailable not missing", async () => {
    if (platform() === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "hwf-acl-root-"));
    const session = new RunHistorySession();
    expect((await session.claim({ ...baseMeta(), checkout_root: root })).state).toBe("claimed");
    const id = session.id!;
    await session.finalize("succeeded");
    session.dispose();
    await chmod(snapshotPath(id), 0o644);
    const detail = await getRunDetail(id);
    expect(detail.kind).toBe("unavailable");
    const listed = await listRunHistory({ checkout_root: null });
    expect(listed.ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("unresolvable claim checkout is unavailable", async () => {
    const session = new RunHistorySession();
    const result = await session.claim({
      ...baseMeta(),
      checkout_root: join(tmpdir(), `missing-${Date.now()}`),
    });
    expect(result).toMatchObject({ ok: true, state: "unavailable" });
    session.dispose();
  });

  test("deleted checkout remains listable under soft canonical filter", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-soft-root-"));
    const session = new RunHistorySession();
    expect((await session.claim({ ...baseMeta(), checkout_root: root })).state).toBe("claimed");
    const id = session.id!;
    await session.finalize("succeeded");
    session.dispose();
    const snap = await readSnapshot(id);
    expect(snap?.checkout_root).toBeTruthy();
    await rm(root, { recursive: true, force: true });
    const listed = await listRunHistory({ checkout_root: snap!.checkout_root });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs.some((r) => r.id === id)).toBe(true);
  });

  test("search matches completed safe step labels", async () => {
    const session = new RunHistorySession();
    await session.claim(baseMeta());
    await session.recordStep({
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
    await session.finalize("succeeded");
    const listed = await listRunHistory({
      text: "unique-shell-label",
      checkout_root: checkoutRoot,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs).toHaveLength(1);
    expect(toListItem((await readSnapshot(session.id!))!).step_labels).toContain(
      "unique-shell-label",
    );
    session.dispose();
  });

  test("retention byte budget counts only terminal snapshots", async () => {
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    const active = new RunHistorySession();
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
    await replaceSnapshotForTest({
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
    await replaceSnapshotForTest({
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
    const trigger = new RunHistorySession();
    await trigger.claim({ ...baseMeta(), workflow: "trigger" });
    await trigger.finalize("succeeded");
    trigger.dispose();
    expect(await readSnapshot(active.id!)).toBeDefined();
    expect(await readSnapshot(newId)).toBeDefined();
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
    const all = await listRunHistory({ checkout_root: null });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.runs.every((r) => r.workflow !== "old-log")).toBe(true);
    expect(await Bun.file(priorPath).text()).toBe(body);
  });

  test("failure explanation is detail-only and not searchable", async () => {
    const session = new RunHistorySession();
    await session.claim(baseMeta());
    await session.recordStep({
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
    await session.finalize("failed");
    const listed = await listRunHistory({ text: "secret-token-xyz", checkout_root: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs).toHaveLength(0);
    const byExit = await listRunHistory({ text: "3", checkout_root: checkoutRoot });
    expect(byExit.ok).toBe(true);
    if (!byExit.ok) return;
    expect(byExit.runs).toHaveLength(1);
    const detail = await getRunDetail(session.id!);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.failure_explanation).toBe("secret-token-xyz");
    expect(JSON.stringify(byExit.runs[0])).not.toContain("secret-token-xyz");
    session.dispose();
  });
});
