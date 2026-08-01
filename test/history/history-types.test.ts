import { describe, expect, test } from "bun:test";
import { allocateRunId } from "../../src/history/store";
import { isSnapshot } from "../../src/history/types";

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
});
