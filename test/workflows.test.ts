import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWorkflow,
  WorkflowLoadError,
  substitute,
  substituteParams,
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

  test('agent: "{agent}" accepted at load', async () => {
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
        session_file: "",
        tab: "",
        prev_tab: "",
        agent: "",
        inputs: {},
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
        session_file: "",
        tab: "t2",
        prev_tab: "t1",
        agent: "codex",
        inputs: {},
      }),
    ).toBe("t=t2 p=t1 a=codex");
  });

  test("{session} in prompt is load error", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: "{session}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(
      /\{session\}\/\{session_file\} only allowed in stdin/,
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

  test("{session_file} in prompt is load error", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: "{session_file}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(
      /\{session\}\/\{session_file\} only allowed in stdin/,
    );
  });

  test("{session_file} in stdin ok; needsSession true", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - shell: cat\n    stdin: "{session_file}"\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.needsSession).toBe(true);
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

describe("inputs", () => {
  const values = (inputs: Record<string, string>) => ({
    pane: "",
    selection: "",
    prompt: "",
    last: "",
    error: "",
    session: "",
    session_file: "",
    tab: "",
    prev_tab: "",
    agent: "",
    inputs,
  });

  test("{input.x} substitutes from inputs map", () => {
    expect(substitute("to {input.target}!", values({ target: "codex" }))).toBe("to codex!");
    expect(substitute("{input.missing}", values({}))).toBe("");
  });

  test("params substitution descends through arrays and preserves non-strings", () => {
    expect(
      substituteParams(
        { items: ["{input.target}", { prompt: "{prompt}", count: 3 }, false, null] },
        { ...values({ target: "codex" }), prompt: "ship it" },
      ),
    ).toEqual({ items: ["codex", { prompt: "ship it", count: 3 }, false, null] });
  });

  test("params substitution preserves __proto__ as data", () => {
    const params = Bun.YAML.parse("payload:\n  __proto__:\n    preserved: yes\n") as Record<
      string,
      unknown
    >;
    const output = substituteParams(params, values({}))!;
    const payload = output.payload as Record<string, unknown>;
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(payload.__proto__).toEqual({ preserved: "yes" });
  });

  test("input refs and prompt in params arrays are discovered", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:
  target: {}
steps:
  - herdr: pane.send
    params:
      items: ["{input.target}", { prompt: "{prompt}" }]
`,
    });
    const m = await loadWorkflow("wf", root);
    expect(m.inputs.map((input) => input.name)).toEqual(["target"]);
    expect(m.needsPrompt).toBe(true);
  });

  test("{session} in params arrays is load error", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:
  - herdr: pane.send
    params:
      items: ["{session}"]
`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(
      /\{session\}\/\{session_file\} only allowed in stdin/,
    );
  });

  test("choice and text inputs resolve; agents sentinel expands", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:
  target:
    options: agents
  focus:
    label: focus area
    default: ""
steps:
  - agent: "{input.target}"
    prompt: "{input.focus}"
`,
    });
    const m = await loadWorkflow("wf", root, ["claude", "codex"]);
    expect(m.inputs).toEqual([
      { name: "target", label: "target", options: ["claude", "codex"], default: undefined },
      { name: "focus", label: "focus area", options: undefined, default: "" },
    ]);
  });

  test("undeclared {input.x} rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `steps:\n  - shell: cat\n    stdin: "{input.nope}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/undeclared input/);
  });

  test("declared but unused input rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  ghost: {}\nsteps:\n  - shell: "true"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/never referenced/);
  });

  test("agent input option outside config rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  target:\n    options: [claude, ghost]\nsteps:\n  - agent: "{input.target}"\n`,
    });
    await expect(loadWorkflow("wf", root, ["claude"])).rejects.toThrow(/not a config agent/);
  });

  test("text input as agent rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  target: {}\nsteps:\n  - agent: "{input.target}"\n`,
    });
    await expect(loadWorkflow("wf", root, ["claude"])).rejects.toThrow(/needs options/);
  });

  test("{input.x} in shell command text rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  x: {}\nsteps:\n  - shell: "echo {input.x}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/input.x.*not allowed in command/);
  });

  test("spliced workflow with inputs rejected", async () => {
    const root = await repoWithWorkflows({
      part: `inputs:\n  x: {}\nsteps:\n  - shell: cat\n    stdin: "{input.x}"\n`,
      wf: `steps:\n  - run: part\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/declares inputs/);
  });

  test("options agents with no configured agents rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  target:\n    options: agents\nsteps:\n  - agent: "{input.target}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/no agents configured/);
  });

  test("choice default outside options rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  target:\n    options: [a, b]\n    default: c\nsteps:\n  - shell: cat\n    stdin: "{input.target}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/not in options/);
  });

  test("recovery may reference entry inputs", async () => {
    const root = await repoWithWorkflows({
      rescue: `steps:\n  - shell: cat\n    stdin: "{input.focus}"\n`,
      wf: `inputs:\n  focus: {}\non_fail: rescue\nsteps:\n  - shell: cat\n    stdin: "{input.focus}"\n`,
    });
    const m = await loadWorkflow("wf", root);
    expect(m.inputs.map((i) => i.name)).toEqual(["focus"]);
  });

  test("options shell command expands stdout lines", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:
  branch:
    options: "printf 'main\\nfeat/x\\n'"
steps:
  - shell: cat
    stdin: "{input.branch}"
`,
    });
    const m = await loadWorkflow("wf", root);
    expect(m.inputs[0]).toEqual({
      name: "branch",
      label: "branch",
      options: ["main", "feat/x"],
      default: undefined,
    });
  });

  test("options shell command failure rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  branch:\n    options: "exit 1"\nsteps:\n  - shell: cat\n    stdin: "{input.branch}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/options command failed/);
  });

  test("options shell command empty stdout rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  branch:\n    options: "true"\nsteps:\n  - shell: cat\n    stdin: "{input.branch}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/no choices/);
  });

  test("dynamic options default outside resolved set rejected", async () => {
    const root = await repoWithWorkflows({
      wf: `inputs:\n  branch:\n    options: "printf 'main\\n'"\n    default: other\nsteps:\n  - shell: cat\n    stdin: "{input.branch}"\n`,
    });
    await expect(loadWorkflow("wf", root)).rejects.toThrow(/not in options/);
  });
});

describe("WorkflowLoadError", () => {
  test("is throwable type", () => {
    expect(new WorkflowLoadError("x")).toBeInstanceOf(Error);
  });
});
