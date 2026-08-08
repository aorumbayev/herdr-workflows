import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
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

function titles(calls: RpcCall[]): unknown[] {
  return notifications(calls).map((params) => params.title);
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

  test("prompt-enhance uses the configured custom agent and this platform's clipboard", async () => {
    const calls = successful(
      await harness.run(
        "prompt-enhance",
        { target: "deterministic", text: "fix it" },
        { WAYLAND_DISPLAY: "wayland-e2e" },
      ),
    );

    const expected = process.platform === "darwin" ? "pbcopy" : "wl-copy";
    expect(await readFile(harness.clipboard, "utf8")).toBe(`${expected}:refined prompt`);
    expect(calls.find((call) => call.method === "agent.start")?.params).toMatchObject({
      kind: "custom",
    });
    expect(titles(calls)).toEqual(["enhancing prompt", "prompt ready"]);
    expect(calls.some((call) => call.method === "pane.close")).toBe(true);
  });

  // macOS never reaches this branch: the workflow guards it on context.platform.
  test.skipIf(process.platform === "darwin")(
    "prompt-enhance falls back to xclip when no Wayland display is set",
    async () => {
      const calls = successful(
        await harness.run(
          "prompt-enhance",
          { target: "deterministic", text: "fix it" },
          { WAYLAND_DISPLAY: "" },
        ),
      );

      expect(await readFile(harness.clipboard, "utf8")).toBe("xclip:refined prompt");
      expect(titles(calls)).toEqual(["enhancing prompt", "prompt ready"]);
    },
  );

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
          expect(calls.filter((call) => call.method === "tab.create")).toHaveLength(2);
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

  test("worktree create runs the full layout with a per-pane agent name", async () => {
    const calls = successful(
      await harness.run("worktree", { mode: "create", ref: "main", branch: "feat-x" }),
    );
    const created = calls.find((call) => call.method === "worktree.create");
    expect(created?.params).toMatchObject({
      cwd: realpathSync(harness.repoRoot),
      branch: "feat-x",
      base: "main",
      label: "feat-x",
      focus: true,
    });
    const rename = calls.find((call) => call.method === "tab.rename");
    expect(rename?.params.label).toBe("work");
    const started = calls.find((call) => call.method === "agent.start");
    expect(started?.params.kind).toBe("claude");
    expect(started?.params.name).toBe(
      `claude-${String(started?.params.pane_id)}`.replace(/[^A-Za-z0-9-]/g, "-"),
    );
    expect(calls.some((call) => call.method === "tab.focus")).toBe(true);
    expect(notifications(calls).map((params) => params.title)).toEqual(["Worktree ready"]);
  });

  test("worktree open targets an existing branch through the same layout", async () => {
    const calls = successful(
      await harness.run("worktree", { mode: "open", worktree: "feature-seed" }),
    );
    const opened = calls.find((call) => call.method === "worktree.open");
    expect(opened?.params).toMatchObject({
      cwd: realpathSync(harness.repoRoot),
      branch: "feature-seed",
      label: "feature-seed",
      focus: true,
    });
    expect(calls.some((call) => call.method === "worktree.create")).toBe(false);
    expect(notifications(calls).map((params) => params.title)).toEqual(["Worktree ready"]);
  });

  test("review-gate notifies on APPROVE and fails the run on REJECT", async () => {
    const approved = successful(
      await harness.run(
        "review-gate",
        { reviewer: "deterministic" },
        { HWF_E2E_GIT_DIRTY: "1", HWF_E2E_REVIEW_VERDICT: "APPROVE" },
      ),
    );
    expect(titles(approved)).toEqual(["review approved"]);
    expect(approved.some((call) => call.method === "pane.close")).toBe(true);

    const rejected = await harness.run(
      "review-gate",
      { reviewer: "deterministic" },
      { HWF_E2E_GIT_DIRTY: "1", HWF_E2E_REVIEW_VERDICT: "REJECT" },
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain("one finding, reported above");
    expect(titles(rejected.calls)).toEqual([]);
  });

  test("review-gate skips the reviewer when the diff is empty", async () => {
    const calls = successful(
      await harness.run("review-gate", { reviewer: "deterministic" }, { HWF_E2E_GIT_DIRTY: "0" }),
    );
    expect(titles(calls)).toEqual(["nothing to review"]);
    expect(calls.some((call) => call.method === "agent.start")).toBe(false);
  });

  test("adversarial-revise runs the revision step only on the REVISE verdict", async () => {
    const scenarios = [
      { verdict: "APPROVE", starts: 2, title: "proposal approved" },
      { verdict: "REVISE", starts: 3, title: "proposal revised" },
    ];
    for (const scenario of scenarios) {
      const calls = successful(
        await harness.run(
          "adversarial-revise",
          { task: "ship a thing", author: "deterministic", critic: "deterministic" },
          { HWF_E2E_CRITIQUE_VERDICT: scenario.verdict },
        ),
      );
      expect(calls.filter((call) => call.method === "agent.start")).toHaveLength(scenario.starts);
      expect(titles(calls)).toEqual([scenario.title]);
    }
  });

  test("remote-branch-log resolves the branch choice from the chosen remote", async () => {
    for (const remote of ["origin", "upstream"]) {
      const calls = successful(
        await harness.run("remote-branch-log", { remote, branch: `${remote}/release` }),
      );
      expect(notifications(calls)).toEqual([
        {
          title: `recent commits on ${remote}/release`,
          body: `abc1234 seed commit on ${remote}/release\n`,
          sound: "done",
        },
      ]);
    }

    const crossed = await harness.run("remote-branch-log", {
      remote: "origin",
      branch: "upstream/release",
    });
    expect(crossed.exitCode).not.toBe(0);
    expect(crossed.stderr).toContain("must be one of: origin/main, origin/release");
  });

  test("worktree open skips agent.start when the reopened pane already has one", async () => {
    const calls = successful(
      await harness.run(
        "worktree",
        { mode: "open", worktree: "feature-seed" },
        { HWF_E2E_AGENT_ON_OPEN: "1" },
      ),
    );

    expect(calls.some((call) => call.method === "worktree.open")).toBe(true);
    expect(calls.filter((call) => call.method === "agent.start")).toHaveLength(0);
    expect(calls.some((call) => call.method === "tab.focus")).toBe(true);
    expect(titles(calls)).toEqual(["Worktree ready"]);
  });

  test("worktree delete removes the checkout and reports the branch outcome", async () => {
    const scenarios: { scope: string; env: Record<string, string>; body: string }[] = [
      {
        scope: "worktree-only",
        env: {},
        body: "removed the feature-seed worktree; branch kept",
      },
      {
        scope: "worktree-and-branch",
        env: {},
        body: "removed the feature-seed worktree and its branch",
      },
      {
        scope: "worktree-and-branch",
        env: { HWF_E2E_BRANCH_UNMERGED: "1" },
        body: "removed the feature-seed worktree; branch kept, it is not merged (git branch -D feature-seed)",
      },
    ];
    for (const scenario of scenarios) {
      const calls = successful(
        await harness.run(
          "worktree",
          { mode: "delete", worktree: "feature-seed", scope: scenario.scope },
          scenario.env,
        ),
      );
      expect(calls.some((call) => call.method === "worktree.create")).toBe(false);
      const shown = notifications(calls);
      expect(shown.map((params) => params.title)).toEqual(["Worktree deleted"]);
      expect(shown[0]?.body).toBe(scenario.body);
    }
  });
});
