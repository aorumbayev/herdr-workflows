import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../src/workflow/load";
import { substitute, substituteParams } from "../src/workflow/parse";

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

const emptyValues = {
  pane: "",
  selection: "",
  prompt: "",
  error: "",
  session: "",
  session_file: "",
  source_tab: "",
  agent: "",
};

describe("workflow grammar", () => {
  test("bare string steps shorthand", async () => {
    const root = await repoWithWorkflows({ ok: `steps: bun test\n` });
    const m = await loadWorkflow("ok", root);
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { form: "scalar", command: "bun test", shell: "sh" },
      in: "here",
    });
  });

  test("unknown top-level key rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `retries: 3\nsteps: bun test\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/retries/);
  });

  test("on_fail points to on_error", async () => {
    const root = await repoWithWorkflows({
      bad: `on_fail: continue\nsteps: bun test\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/on_error/);
  });

  test("missing steps rejected", async () => {
    const root = await repoWithWorkflows({ bad: `inputs:\n  x: text\n` });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/steps/);
  });

  test("two action keys rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: bun test\n    agent: claude\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/multiple action keys/);
  });

  test("modifiers only rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - out: diff\n    when: "{x}"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/no action key/);
  });

  test("placeholder rejected in scalar run", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: git checkout {base}\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/placeholders are not allowed/);
  });

  test("placeholder accepted in argv run", async () => {
    const root = await repoWithWorkflows({
      ok: `inputs:\n  base: text\nsteps:\n  - run: [git, checkout, "{base}"]\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { form: "argv", argv: ["git", "checkout", "{base}"] },
    });
  });

  test("shell on argv form rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: [git, status]\n    shell: bash\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/argv form does not use a shell/);
  });

  test("explicit interpreter", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - run: Get-ChildItem\n    shell: pwsh\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { shell: "pwsh", command: "Get-ChildItem" },
    });
  });

  test("ratio without split rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: bun\n    in: tab\n    ratio: 0.5\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/ratio/);
  });

  test("regex wait on here rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: bun run dev\n    in: here\n    wait: /listening/\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/placed step/);
  });

  test("detached step with out rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: lazygit\n    in: tab\n    wait: false\n    out: { tab: tab_id }\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/detached/);
  });

  test("two outputs coexist", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:
  - run: git diff HEAD
    out: diff
  - run: git log -5 --oneline
    out: recent
  - agent: claude
    prompt: "{diff} {recent}"
`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.steps.map((s) => (s.out && s.out.kind === "text" ? s.out.name : null))).toEqual([
      "diff",
      "recent",
      null,
    ]);
  });

  test("choice shorthand with default", async () => {
    const root = await repoWithWorkflows({
      ok: `inputs:\n  base: [main, develop] = main\nsteps:\n  - run: [echo, "{base}"]\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.inputs[0]).toMatchObject({
      name: "base",
      options: ["main", "develop"],
      default: "main",
    });
  });

  test("shell-sourced choices", async () => {
    const root = await repoWithWorkflows({
      ok: `inputs:\n  branch: sh printf 'main\\nfeat/x\\n'\nsteps:\n  - run: [echo, "{branch}"]\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.inputs[0]!.options).toEqual(["main", "feat/x"]);
  });

  test("unused input rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `inputs:\n  focus: text\nsteps:\n  - run: "true"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/never referenced/);
  });

  test("default outside options rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `inputs:\n  base: [main, develop] = trunk\nsteps:\n  - run: [echo, "{base}"]\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/not in options/);
  });

  test("typo placeholder caught at load", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: git diff\n    out: diff\n  - agent: claude\n    prompt: "{dif}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/dif/);
  });

  test("collision with builtin rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: echo\n    out: agent\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/builtin/);
  });

  test("JSON braces pass through", () => {
    expect(substitute('{"key": "value"}', emptyValues)).toBe('{"key": "value"}');
  });

  test("session legal in prompt", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - agent: claude\n    prompt: "{session}"\n`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.needsSession).toBe(true);
  });

  test("session rejected in scalar run", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: "echo {session}"\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/placeholders are not allowed/);
  });

  test("v1 shell key rejected", async () => {
    const root = await repoWithWorkflows({ bad: `steps:\n  - shell: bun test\n` });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/run:/);
  });

  test("v1 last placeholder rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: "{last}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/out:/);
  });

  test("v1 input namespace rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `inputs:\n  focus: text\nsteps:\n  - agent: claude\n    prompt: "{input.focus}"\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/\{focus\}/);
  });

  test("wait: done rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: hi\n    wait: done\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/wait: done/);
  });

  test("agent defaults to in: tab and blocking", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - agent: claude\n    prompt: hi\n`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.steps[0]!.action).toMatchObject({ kind: "agent", in: "tab" });
    expect(m.steps[0]!.wait).toEqual({ kind: "block" });
  });

  test("unknown agent rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: gemini\n    prompt: hi\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/gemini/);
  });

  test('agent: "{agent}" accepted', async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - agent: "{agent}"\n    prompt: hi\n`,
    });
    const m = await loadWorkflow("ok", root, ["claude"]);
    expect(m.needsInvokingAgent).toBe(true);
  });
});

describe("step control flow load rules", () => {
  test("placeholder in shell when rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: bun test\n    when: 'test -n "{diff}"'\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/placeholders are not allowed/);
  });

  test("item outside for rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: [echo, "{item}"]\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/requires for:/);
  });

  test("empty for list rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: [echo, x]\n    for: []\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/empty/);
  });

  test("retry: 0 rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - run: bun test\n    retry: 0\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/at least 1/);
  });

  test("retry on agent without reset rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - agent: claude\n    prompt: hi\n    retry: 3\n`,
    });
    await expect(loadWorkflow("bad", root, ["claude"])).rejects.toThrow(/strand/);
  });

  test("retry on local run without reset ok", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - run: bun test\n    retry: 3\n`,
    });
    await expect(loadWorkflow("ok", root)).resolves.toBeTruthy();
  });

  test("retry on placed run with reset ok", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - run: bun run dev\n    in: right\n    retry:\n      times: 2\n      reset: "true"\n`,
    });
    await expect(loadWorkflow("ok", root)).resolves.toBeTruthy();
  });

  test("for literal list parses", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - run: [echo, "{item}"]\n    for: [a.ts, b.ts]\n`,
    });
    const m = await loadWorkflow("ok", root);
    expect(m.steps[0]!.for).toEqual({ kind: "list", items: ["a.ts", "b.ts"] });
  });
});

describe("composition", () => {
  test("use includes steps", async () => {
    const root = await repoWithWorkflows({
      gate: `steps:\n  - run: test\n`,
      ship: `steps:\n  - run: lint\n  - use: gate\n  - run: git push\n`,
    });
    const m = await loadWorkflow("ship", root);
    expect(m.steps.map((s) => s.action.kind)).toEqual(["run", "include", "run"]);
  });

  test("unknown use target rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - use: nonexistent\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/nonexistent/);
  });

  test("cycle rejected", async () => {
    const root = await repoWithWorkflows({
      a: `steps:\n  - use: b\n`,
      b: `steps:\n  - use: a\n`,
    });
    await expect(loadWorkflow("a", root)).rejects.toThrow(/cycle/);
  });

  test("with undeclared key rejected", async () => {
    const root = await repoWithWorkflows({
      gate: `inputs:\n  suite: text = unit\nsteps:\n  - run: [echo, "{suite}"]\n`,
      ship: `steps:\n  - use: gate\n    with: { suit: all }\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/undeclared/);
  });

  test("required with missing rejected", async () => {
    const root = await repoWithWorkflows({
      gate: `inputs:\n  branch: text\nsteps:\n  - run: [echo, "{branch}"]\n`,
      ship: `steps:\n  - use: gate\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/branch/);
  });

  test("default applied when with omitted", async () => {
    const root = await repoWithWorkflows({
      gate: `inputs:\n  suite: [unit, all] = unit\nsteps:\n  - run: [echo, "{suite}"]\n`,
      ship: `steps:\n  - use: gate\n`,
    });
    const m = await loadWorkflow("ship", root);
    expect(m.steps[0]!.action).toMatchObject({
      kind: "include",
      defaults: { suite: "unit" },
    });
  });

  test("no implicit inheritance into include", async () => {
    const root = await repoWithWorkflows({
      part: `steps:\n  - agent: claude\n    prompt: "{diff}"\n`,
      ship: `steps:\n  - run: git diff\n    out: diff\n  - use: part\n`,
    });
    await expect(loadWorkflow("ship", root, ["claude"])).rejects.toThrow(/diff/);
  });

  test("included out visible downstream", async () => {
    const root = await repoWithWorkflows({
      part: `steps:\n  - run: echo hi\n    out: report\n`,
      ship: `steps:\n  - use: part\n  - run: [echo, "{report}"]\n`,
    });
    await expect(loadWorkflow("ship", root)).resolves.toBeTruthy();
  });

  test("collision across inclusion rejected", async () => {
    const root = await repoWithWorkflows({
      part: `steps:\n  - run: echo\n    out: diff\n`,
      ship: `steps:\n  - run: echo\n    out: diff\n  - use: part\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/collides/);
  });

  test("recovery declaring inputs rejected", async () => {
    const root = await repoWithWorkflows({
      rescue: `inputs:\n  x: text\nsteps:\n  - run: [echo, "{x}"]\n`,
      ship: `on_error: rescue\nsteps:\n  - run: "true"\n`,
    });
    await expect(loadWorkflow("ship", root)).rejects.toThrow(/cannot declare inputs/);
  });

  test("HWF_ env exact match still required", async () => {
    const root = await repoWithWorkflows({
      bad: `inputs:\n  foo: text\nsteps:\n  - run: 'printf %s "$HWF_foobar"'\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/never referenced/);
  });

  test("HWF_ exact env ref counts as use", async () => {
    const root = await repoWithWorkflows({
      ok: `inputs:\n  foo: text\nsteps:\n  - run: 'printf %s "$HWF_foo"'\n`,
    });
    await expect(loadWorkflow("ok", root)).resolves.toBeTruthy();
  });
});

describe("primitives", () => {
  test("denied method rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - server.stop:\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/server/);
  });

  test("unknown method rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - pane.splitt: { direction: right }\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/unknown herdr method/);
  });

  test("identifier out on primitive rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - tab.create: { label: logs }\n    out: tab\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/map-form/);
  });

  test("bad result path rejected", async () => {
    const root = await repoWithWorkflows({
      bad: `steps:\n  - pane.split: { direction: right }\n    out: { pane: pane.pane_ids }\n`,
    });
    await expect(loadWorkflow("bad", root)).rejects.toThrow(/unresolvable/);
  });

  test("notification.show allowed", async () => {
    const root = await repoWithWorkflows({
      ok: `steps:\n  - notification.show: { title: done }\n`,
    });
    await expect(loadWorkflow("ok", root)).resolves.toBeTruthy();
  });
});

describe("substitution", () => {
  test("flat namespace substitutes", () => {
    expect(substitute("to {target}!", { ...emptyValues, target: "codex" })).toBe("to codex!");
  });

  test("params substitution descends", () => {
    expect(
      substituteParams(
        { items: ["{target}", { prompt: "{prompt}", count: 3 }] },
        { ...emptyValues, target: "codex", prompt: "ship it" },
      ),
    ).toEqual({ items: ["codex", { prompt: "ship it", count: 3 }] });
  });
});
