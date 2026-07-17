import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { globalConfigPath } from "../src/config";
import type { WorkflowListEntry } from "../src/workflows";
import { recentRuns, type RunLogEntry } from "../src/runlog";
import {
  buildConfigOptions,
  buildWorkflowOptions,
  buildRunOptions,
  formatRunPreview,
  isValidWorkflowName,
  previewLines,
  type ManageRowValue,
} from "../src/tui/manage-rows";

void null as unknown as ManageRowValue;

describe("manage row building", () => {
  test("workflows: richer descriptions, filter, no separator", () => {
    const workflows: WorkflowListEntry[] = [
      { name: "ok", source: "repo", file: "/r/.hwf/workflows/ok.yaml" },
      {
        name: "broken",
        source: "global",
        file: "/g/broken.yaml",
        error: "/g/broken.yaml, step 2, agent: unknown agent 'x'",
      },
      { name: "ship", source: "repo", file: "/r/.hwf/workflows/ship.yaml" },
    ];
    const options = buildWorkflowOptions(workflows);
    expect(options.map((o) => o.name)).toEqual(["ok", "broken", "ship"]);
    expect(options[0]!.description).toBe("repo · ok.yaml");
    expect(options[1]!.description).toBe("global · invalid: step 2, agent: unknown agent 'x'");
    expect(buildWorkflowOptions(workflows, "shi").map((o) => o.name)).toEqual(["ship"]);
  });

  test("config rows without separator", () => {
    const options = buildConfigOptions(true, false, "/repo");
    expect(options.map((o) => o.name)).toEqual(["config (repo)", "config (global)"]);
    expect(options[0]!.description).toBe(".hwf/config.yaml");
    expect(options[1]!.description).toBe("~/.hwf/config.yaml · missing");
    expect(options[0]!.value).toEqual({
      kind: "config",
      scope: "repo",
      file: join("/repo", ".hwf", "config.yaml"),
      missing: false,
    });
    expect(options[1]!.value).toEqual({
      kind: "config",
      scope: "global",
      file: globalConfigPath(),
      missing: true,
    });
  });

  test("run options filter by workflow name", () => {
    const runs: RunLogEntry[] = [
      { ts: "t1", run: "a1", workflow: "review", ok: true },
      { ts: "t2", run: "a2", workflow: "handoff", ok: false, error: "boom" },
    ];
    const options = buildRunOptions(runs, "hand");
    expect(options).toHaveLength(1);
    expect(options[0]!.name).toBe("handoff  a2");
    expect(options[0]!.description).toBe("fail · t2");
  });

  test("run preview lists steps", () => {
    const entries: RunLogEntry[] = [
      { ts: "t", run: "r1", workflow: "m", step: 1, total: 2, label: "shell: x", ok: true },
      {
        ts: "t",
        run: "r1",
        workflow: "m",
        step: 2,
        total: 2,
        label: "agent: c",
        ok: false,
        error: "nope",
      },
      { ts: "t", run: "r1", workflow: "m", ok: false, error: "nope" },
    ];
    const text = formatRunPreview(entries, "r1", {
      kind: "run",
      run: "r1",
      workflow: "m",
      ok: false,
      error: "nope",
      ts: "t",
    });
    expect(text).toContain("ok 1/2 shell: x");
    expect(text).toContain("fail 2/2 agent: c: nope");
  });

  test("previewLines truncates", () => {
    expect(previewLines("a\nb\nc", 2)).toBe("a\nb\n…");
  });

  test("recentRuns: finals only, newest first", () => {
    const entries: RunLogEntry[] = [
      { ts: "1", run: "a", workflow: "m", step: 1, total: 1, label: "x", ok: true },
      { ts: "2", run: "a", workflow: "m", ok: true },
      { ts: "3", run: "b", workflow: "n", ok: false },
    ];
    expect(recentRuns(entries).map((e) => e.run)).toEqual(["b", "a"]);
  });
});

describe("workflow name validation", () => {
  test("accepts kebab and snake", () => {
    expect(isValidWorkflowName("chat-handoff")).toBe(true);
    expect(isValidWorkflowName("deploy_notes")).toBe(true);
    expect(isValidWorkflowName("a")).toBe(true);
    expect(isValidWorkflowName("a9")).toBe(true);
  });

  test("rejects empty uppercase and leading dash", () => {
    expect(isValidWorkflowName("")).toBe(false);
    expect(isValidWorkflowName("Bad")).toBe(false);
    expect(isValidWorkflowName("-x")).toBe(false);
    expect(isValidWorkflowName("_x")).toBe(false);
    expect(isValidWorkflowName("has space")).toBe(false);
  });
});
