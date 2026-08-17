import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presentRunDetail, projectStatus, toDetail, type RunDetailBlock } from "../../src/history";
import { allocateRunId, runsDir } from "../../src/history";
import {
  RUN_HISTORY_STALE_MS,
  isSnapshot,
  type RunDetail,
  type RunSnapshot,
} from "../../src/history";
import { formatRunDetailLines } from "../../src/runs-browser";
import { writeTestSnapshot } from "../fakes/helpers/history-snapshot";

function snapshot(
  partial: Partial<Extract<RunDetail, { kind: "snapshot" }>> &
    Pick<Extract<RunDetail, { kind: "snapshot" }>, "id" | "workflow">,
): Extract<RunDetail, { kind: "snapshot" }> {
  const now = new Date().toISOString();
  return {
    kind: "snapshot",
    display_id: partial.id.slice(0, 8),
    source: "repo",
    checkout_root: "/repo",
    status: "succeeded",
    started_at: now,
    heartbeat_at: now,
    elapsed_ms: 1200,
    steps: [],
    ...partial,
  };
}

/** Web renderer text extraction — mirrors page.html appendRunBlock copy. */
function webTexts(blocks: RunDetailBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "head") {
      out.push(
        [block.status, block.title, block.display_id, block.elapsed].filter(Boolean).join(" · "),
      );
      continue;
    }
    if (block.kind === "note" || block.kind === "error") {
      out.push(block.text);
      continue;
    }
    out.push(
      `${block.ordinal}/${block.total} ${block.label}${block.outcome ? ` · ${block.outcome}` : ""}`,
    );
    if (block.explanation) out.push(block.explanation);
  }
  return out;
}

describe("presentRunDetail", () => {
  test("invalid and missing become error blocks", () => {
    expect(presentRunDetail({ kind: "invalid", message: "bad id" })).toEqual([
      { kind: "error", text: "bad id" },
    ]);
    expect(presentRunDetail({ kind: "missing", id: "x", message: "gone" })).toEqual([
      { kind: "error", text: "gone" },
    ]);
  });

  test("empty snapshot includes no-step-outcomes note", () => {
    const blocks = presentRunDetail(
      snapshot({ id: "550e8400-e29b-41d4-a716-446655440099", workflow: "demo" }),
    );
    expect(blocks.some((b) => b.kind === "note" && b.text === "no step outcomes yet")).toBe(true);
  });

  test("stale banner, remaining, and failure fallback", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const stale = presentRunDetail(
      snapshot({
        id,
        workflow: "live",
        status: "stale",
        steps: [],
      }),
    );
    expect(stale.some((b) => b.kind === "note" && b.text.includes("heartbeat stale"))).toBe(true);

    const remaining = presentRunDetail(
      snapshot({
        id,
        workflow: "partial",
        status: "failed",
        steps: [
          {
            phase: "main",
            workflow: "partial",
            workflow_path: ["partial"],
            ordinal: 1,
            total: 3,
            action: "run",
            label: "one",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            outcome: "succeeded",
          },
        ],
        remaining: 2,
        failure_explanation: "boom",
      }),
    );
    expect(remaining.some((b) => b.kind === "note" && b.text === "2 steps not run")).toBe(true);
    expect(remaining.some((b) => b.kind === "error" && b.text === "boom")).toBe(true);

    const explained = presentRunDetail(
      snapshot({
        id,
        workflow: "explained",
        status: "failed",
        steps: [
          {
            phase: "main",
            workflow: "explained",
            workflow_path: ["explained"],
            ordinal: 1,
            total: 1,
            action: "run",
            label: "shell",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            outcome: "failed",
            explanation: "step boom",
          },
        ],
        failure_explanation: "fallback should not show",
      }),
    );
    expect(explained.some((b) => b.kind === "error")).toBe(false);
    expect(explained.some((b) => b.kind === "step" && b.explanation === "step boom")).toBe(true);
  });

  test("truncated read marks the step outcome in both renderers", () => {
    const now = new Date().toISOString();
    const detail = snapshot({
      id: "550e8400-e29b-41d4-a716-446655440777",
      workflow: "reads",
      steps: [
        {
          phase: "main",
          workflow: "reads",
          workflow_path: ["reads"],
          ordinal: 1,
          total: 1,
          action: "herdr",
          label: "herdr pane.read",
          started_at: now,
          finished_at: now,
          outcome: "succeeded",
          truncated: true,
        },
      ],
    });
    const blocks = presentRunDetail(detail);
    const step = blocks.find((b) => b.kind === "step");
    expect(step?.kind === "step" ? step.outcome : "").toBe("succeeded (truncated read)");
    expect(formatRunDetailLines(blocks, 120).join("\n")).toContain("truncated read");
    expect(webTexts(blocks).join("\n")).toContain("truncated read");
  });

  test.each([
    {
      name: "stale",
      detail: snapshot({
        id: "550e8400-e29b-41d4-a716-446655440000",
        workflow: "live",
        status: "stale" as const,
      }),
      needle: "writer heartbeat stale - not a failure",
    },
    {
      name: "remaining",
      detail: snapshot({
        id: "550e8400-e29b-41d4-a716-446655440001",
        workflow: "partial",
        status: "failed" as const,
        remaining: 1,
        steps: [
          {
            phase: "main" as const,
            workflow: "partial",
            workflow_path: ["partial"],
            ordinal: 1,
            total: 2,
            action: "run" as const,
            label: "one",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            outcome: "succeeded" as const,
          },
        ],
      }),
      needle: "1 step not run",
    },
    {
      name: "failure-fallback",
      detail: snapshot({
        id: "550e8400-e29b-41d4-a716-446655440002",
        workflow: "boom",
        status: "failed" as const,
        failure_explanation: "top-level failure",
        steps: [
          {
            phase: "main" as const,
            workflow: "boom",
            workflow_path: ["boom"],
            ordinal: 1,
            total: 1,
            action: "run" as const,
            label: "shell",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            outcome: "failed" as const,
          },
        ],
      }),
      needle: "top-level failure",
    },
  ])("TUI and web agree on $name", ({ detail, needle }) => {
    const blocks = presentRunDetail(detail);
    const tui = formatRunDetailLines(blocks, 120).join("\n");
    const web = webTexts(blocks).join("\n");
    expect(tui).toContain(needle);
    expect(web).toContain(needle);
    expect(webTexts(blocks).some((line) => tui.includes(line.split(" · ")[0]!))).toBe(true);
  });
});

let stateDir: string;
let prevState: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hwf-hist-proj-"));
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  await rm(stateDir, { recursive: true, force: true });
});

describe("run history projection", () => {
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
    await writeTestSnapshot(snap);
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
    await writeTestSnapshot(snap);
    const detail = toDetail(snap);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.steps.map((s) => s.label)).toEqual(["wrap1", "inner1", "wrap2", "inner2"]);
  });
});
