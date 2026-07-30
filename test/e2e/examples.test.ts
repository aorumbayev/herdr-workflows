import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExampleHarness, type RpcCall, type RunResult } from "./examples-harness";

let harness: ExampleHarness;

beforeEach(async () => {
  harness = await ExampleHarness.create();
});

afterEach(async () => {
  await harness.close();
});

function successful(result: RunResult): RpcCall[] {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return result.calls;
}

function notifications(calls: RpcCall[]): Record<string, unknown>[] {
  return calls.filter((call) => call.method === "notification.show").map((call) => call.params);
}

describe("shipped examples through isolated CLI and fake Herdr", () => {
  test("branch-check covers clean, changed, existing, and available outcomes", async () => {
    const scenarios: {
      inputs: Record<string, string>;
      env: Record<string, string>;
      title: string;
    }[] = [
      {
        inputs: { mode: "status" },
        env: { HWF_E2E_GIT_DIRTY: "0" },
        title: "working tree clean",
      },
      {
        inputs: { mode: "status" },
        env: { HWF_E2E_GIT_DIRTY: "1" },
        title: "working tree changed",
      },
      {
        inputs: { mode: "branch", branch: "main" },
        env: { HWF_E2E_BRANCH_EXISTS: "1" },
        title: "branch exists",
      },
      {
        inputs: { mode: "branch", branch: "new-feature" },
        env: { HWF_E2E_BRANCH_EXISTS: "0" },
        title: "branch available",
      },
    ];

    for (const scenario of scenarios) {
      const calls = successful(await harness.run("branch-check", scenario.inputs, scenario.env));
      expect(notifications(calls).map((params) => params.title)).toEqual([scenario.title]);
    }
  });

  test("prompt-enhance uses the configured custom agent and native clipboard branch", async () => {
    const calls = successful(
      await harness.run("prompt-enhance", {
        target: "deterministic",
        text: "fix it",
      }),
    );

    expect(await readFile(harness.clipboard, "utf8")).toBe("refined prompt");
    expect(calls.find((call) => call.method === "agent.start")?.params).toMatchObject({
      kind: "custom",
    });
    expect(notifications(calls).map((params) => params.title)).toEqual([
      "enhancing prompt",
      "prompt ready",
    ]);
    expect(calls.some((call) => call.method === "pane.close")).toBe(true);
  });

  test("handoff preserves the target and cleans up at the selected granularity", async () => {
    for (const placement of ["tab", "beside", "below"]) {
      for (const closeSource of ["keep", "close"]) {
        const calls = successful(
          await harness.run("handoff", {
            target: "deterministic",
            focus: "",
            placement,
            close_source: closeSource,
          }),
        );
        const starts = calls.filter((call) => call.method === "agent.start");
        expect(starts).toHaveLength(2);
        expect(await readFile(join(harness.repoRoot, ".hwf", "tmp", "handoff.md"), "utf8")).toBe(
          "deterministic handoff",
        );
        const targetPane = String(starts[1]?.params.pane_id);
        const sourcePaneCloses = calls.filter(
          (call) => call.method === "pane.close" && call.params.pane_id === "w1:p1",
        );
        const sourceTabCloses = calls.filter(
          (call) => call.method === "tab.close" && call.params.tab_id === "w1:t1",
        );

        expect(
          calls.some((call) => call.method === "pane.close" && call.params.pane_id === targetPane),
        ).toBe(false);
        if (closeSource === "keep") {
          expect(sourcePaneCloses).toHaveLength(0);
          expect(sourceTabCloses).toHaveLength(0);
        } else if (placement === "tab") {
          expect(sourceTabCloses).toHaveLength(1);
          expect(sourcePaneCloses).toHaveLength(0);
        } else {
          expect(sourcePaneCloses).toHaveLength(1);
          expect(sourceTabCloses).toHaveLength(0);
        }

        if (placement === "tab") {
          expect(calls.filter((call) => call.method === "tab.create")).toHaveLength(1);
        } else {
          const expectedDirection = placement === "beside" ? "right" : "down";
          expect(
            calls.some(
              (call) =>
                call.method === "pane.split" &&
                call.params.direction === expectedDirection &&
                call.params.target_pane_id === "w1:p1",
            ),
          ).toBe(true);
        }
      }
    }
  });
});
