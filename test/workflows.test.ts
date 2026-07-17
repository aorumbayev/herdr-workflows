import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWorkflow,
  WorkflowLoadError,
  substitute,
  type FlatStep,
  type LoadedWorkflow,
  type WorkflowListEntry,
  type PlaceholderValues,
} from "../src/workflows";

void null as unknown as FlatStep;
void null as unknown as LoadedWorkflow;
void null as unknown as WorkflowListEntry;
void null as unknown as PlaceholderValues;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWithWorkflows(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-workflows-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.yaml`), body);
  }
  return root;
}

describe("workflow schema", () => {
  test("valid shell+stdin parses", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - shell: echo hi\n    stdin: "{pane}"\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.steps).toEqual([{ verb: "shell", command: "echo hi", stdin: "{pane}" }]);
  });

  test("two verbs rejected with step position", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - shell: echo\n    open: lazygit\n`,
    });
    expect(loadWorkflow("bad", root)).rejects.toThrow(/step 1/);
  });

  test("modifier on wrong verb rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - open: lazygit\n    prompt: hi\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/step 1.*prompt/);
  });

  test("modifier on run rejected", async () => {
    const root = await repoWithWorkflows({
      other: `steps:\n  - shell: "true"\n`,
      bad: `steps:\n  - run: other\n    stdin: x\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/step 1/);
  });

  test("unknown top-level key rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `retries: 3\nsteps:\n  - shell: "true"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/retries/);
  });

  test("empty steps rejected", async () => {
    const root = await repoWithWorkflows({ bad: `steps: []\n` });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/steps/);
  });

  test("unknown agent rejected at load", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: gemini\n    prompt: hi\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/gemini/);
  });

  test("agent: \"{agent}\" accepted at load", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - agent: "{agent}"\n    prompt: hi\n`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.steps[0]).toEqual({ verb: "agent", name: "{agent}", prompt: "hi" });
    expect(m.needsInvokingAgent).toBe(true);
  });

  test("wait on shell rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - shell: echo hi\n    wait: done\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/wait only allowed on agent/);
  });

  test("wait_for on agent rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    wait_for: ready\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(
      /wait_for only allowed on open/,
    );
  });

  test("timeout without wait rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - shell: echo hi\n    timeout: 10\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/timeout requires wait or wait_for/);
  });

  test("wait: whatever rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    wait: whatever\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/wait/);
  });

  test("valid wait/wait_for parse to FlatStep with timeoutMs", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:
  - agent: claude
    prompt: hi
    wait: done
  - open: bun run dev
    wait_for: "Listening on :3000"
    timeout: 45
`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.steps).toEqual([
      { verb: "agent", name: "claude", prompt: "hi", wait: true, timeoutMs: 1_800_000 },
      {
        verb: "open",
        command: "bun run dev",
        waitFor: "Listening on :3000",
        timeoutMs: 45_000,
      },
    ]);
  });
});

describe("substitution safety", () => {
  test("placeholder in shell command rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - shell: "echo {pane}"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toMatchObject({
      name: "WorkflowLoadError",
      message: expect.stringMatching(/step 1.*placeholder \{pane\}/),
    });
  });

  test("placeholder in open command rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - open: "echo {selection}"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/step 1/);
  });

  test("unknown token passes through in substitute", () => {
    expect(
      substitute("{branch}", {
        pane: "",
        selection: "",
        prompt: "",
        last: "",
        error: "",
        session: "",
        tab: "",
        prev_tab: "",
        agent: "",
      }),
    ).toBe("{branch}");
  });

  test("tab prev_tab agent substitute", () => {
    expect(
      substitute("t={tab} p={prev_tab} a={agent}", {
        pane: "",
        selection: "",
        prompt: "",
        last: "",
        error: "",
        session: "",
        tab: "t2",
        prev_tab: "t1",
        agent: "codex",
      }),
    ).toBe("t=t2 p=t1 a=codex");
  });

  test("{session} in prompt is load error", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: "{session}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(
      /\{session\} only allowed in stdin/,
    );
  });

  test("{session} in stdin ok; needsSession true", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - shell: cat\n    stdin: "{session}"\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.needsSession).toBe(true);
    expect(m.steps).toEqual([{ verb: "shell", command: "cat", stdin: "{session}" }]);
  });

  test("workflow without {session} has needsSession false", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - shell: "true"\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.needsSession).toBe(false);
  });
});

describe("composition", () => {
  test("run splices steps in place", async () => {
    const root = await repoWithWorkflows({
      gate: `steps:\n  - shell: test\n`,
      ship: `steps:\n  - shell: lint\n  - run: gate\n  - open: lazygit\n`,
    });
    const m = await loadWorkflow("ship", root);
    expect(m.steps.map((s) => ("command" in s ? s.command : s.verb))).toEqual([
      "lint",
      "test",
      "lazygit",
    ]);
  });

  test("unknown run target rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: nonexistent\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/nonexistent/);
  });

  test("cycle rejected", async () => {
    const root = await repoWithWorkflows({
      a: `steps:\n  - run: b\n`,
      b: `steps:\n  - run: a\n`,
    });
    await expect(loadWorkflow("a", root)).rejects.toThrow(/cycle/);
  });

  test("self-reference rejected", async () => {
    const root = await repoWithWorkflows({
      a: `steps:\n  - run: a\n`,
    });
    await expect(loadWorkflow("a", root)).rejects.toThrow(/cycle/);
  });

  test("on_fail on run target rejected", async () => {
    const root = await repoWithWorkflows({
      gate: `steps:\n  - shell: "true"\non_fail: handoff\n`,
      handoff: `steps:\n  - shell: "true"\n`,
      ship: `steps:\n  - run: gate\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/on_fail/);
  });

  test("on_fail on recovery target rejected", async () => {
    const root = await repoWithWorkflows({
      nested: `steps:\n  - shell: "true"\non_fail: x\n`,
      x: `steps:\n  - shell: "true"\n`,
      ship: `steps:\n  - shell: "true"\non_fail: nested\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/on_fail/);
  });

  test("needsPrompt true when recovery references prompt", async () => {
    const root = await repoWithWorkflows({
      handoff: `steps:\n  - agent: claude\n    prompt: "{prompt}"\n`,
      ship: `steps:\n  - shell: "true"\non_fail: handoff\n`,
    });
    const m = await loadWorkflow("ship", root, ["claude"]);
    expect(m.needsPrompt).toBe(true);
    expect(m.onFail).toBe("handoff");
  });
});

describe("WorkflowLoadError", () => {
  test("is throwable type", () => {
    expect(new WorkflowLoadError("x")).toBeInstanceOf(Error);
  });
});
