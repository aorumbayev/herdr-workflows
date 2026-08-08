import { describe, expect, test } from "bun:test";
import {
  allocateRunId,
  formatProgressLine,
  isSnapshot,
  parseProgressLine,
  type ProgressLine,
} from "../../src/history";

describe("run snapshot schema", () => {
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

  test("truncated step fact is accepted only as literal true", () => {
    const now = new Date().toISOString();
    const withTruncated = (truncated: unknown) => ({
      version: 1,
      id: allocateRunId(),
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
          ordinal: 1,
          total: 1,
          action: "herdr",
          label: "herdr pane.read",
          finished_at: now,
          outcome: "succeeded",
          truncated,
        },
      ],
    });
    expect(isSnapshot(withTruncated(true))).toBe(true);
    expect(isSnapshot(withTruncated(false))).toBe(false);
    expect(isSnapshot(withTruncated("yes"))).toBe(false);
  });
});

describe("progress line codec", () => {
  const cases: ProgressLine[] = [
    { index: 1, total: 3, label: "build", outcome: "start" },
    { index: 2, total: 3, label: "build", outcome: "ok" },
    { index: 3, total: 3, label: "run: git diff HEAD", outcome: "skip" },
    { index: 3, total: 12, label: "review", outcome: "fail" },
    { index: 10, total: 10, label: "notification.show", outcome: "launch" },
  ];

  test("every outcome round-trips through the visible format", () => {
    for (const progress of cases) {
      expect(parseProgressLine(formatProgressLine(progress))).toEqual(progress);
    }
  });

  test("the visible format is unchanged", () => {
    expect(formatProgressLine({ index: 1, total: 2, label: "probe", outcome: "start" })).toBe(
      "[1/2] probe…",
    );
    expect(formatProgressLine({ index: 1, total: 2, label: "probe", outcome: "ok" })).toBe(
      "[1/2] probe",
    );
    expect(formatProgressLine({ index: 2, total: 2, label: "probe", outcome: "fail" })).toBe(
      "[2/2] probe fail",
    );
  });

  test("non-progress lines decode to undefined", () => {
    expect(parseProgressLine("@hwf-history:claimed abc")).toBeUndefined();
    expect(parseProgressLine("plain diagnostic")).toBeUndefined();
    expect(parseProgressLine("[1/2]")).toBeUndefined();
  });
});
