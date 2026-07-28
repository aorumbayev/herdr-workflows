import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../src/config";
import { loadWorkflow, parseWorkflowText } from "../src/workflow/load";
import {
  isWholeValueTemplate,
  parseDurationMs,
  parseRaw,
  parseTemplatePath,
  renderScalar,
  substituteParams,
  substituteText,
  substituteValue,
  textTemplates,
} from "../src/workflow/parse";
import type { TemplateNamespace } from "../src/workflow/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const emptyConfig: WorkflowsConfig = { profiles: {}, transcripts: {} };

async function repoWith(
  files: Record<string, string>,
  config: WorkflowsConfig = emptyConfig,
): Promise<{ root: string; config: WorkflowsConfig }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-loader-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(join(dir, `${name}.yaml`), body)),
  );
  return { root, config };
}

const emptyNs: TemplateNamespace = {
  inputs: {},
  steps: {},
  context: {
    workspace: "",
    tab: "",
    pane: "",
    worktree: "",
    agent: "",
    selection: "",
    platform: "macos",
  },
};

function parse(body: string) {
  return parseRaw("test.yaml", body);
}

describe("v1alpha1 grammar", () => {
  test("workflow names cannot escape workflow directories", async () => {
    const { root, config } = await repoWith({});
    await expect(loadWorkflow("../../outside", root, config)).rejects.toThrow(/workflow name/);
  });

  test("minimal alpha document", () => {
    const doc = parse(`version: v1alpha1\nsteps:\n  - run: bun test\n`);
    expect(doc.version).toBe("v1alpha1");
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { form: "shell", command: "bun test" },
    });
  });

  test("unsupported alpha revision", () => {
    expect(() => parse(`version: v1alpha2\nsteps:\n  - run: "true"\n`)).toThrow(
      /unsupported workflow format 'v1alpha2'.*v1alpha1/,
    );
  });

  test("missing version", () => {
    expect(() => parse(`steps:\n  - run: "true"\n`)).toThrow(/version is required/);
  });

  test("unknown top-level key", () => {
    expect(() => parse(`version: v1alpha1\nretries: 3\nsteps:\n  - run: "true"\n`)).toThrow(
      /Unrecognized key: "retries"/,
    );
  });

  test("title description hidden metadata", () => {
    const doc = parse(
      `version: v1alpha1\ntitle: Ship\ndescription: push\nhidden: true\nsteps:\n  - run: "true"\n`,
    );
    expect(doc.title).toBe("Ship");
    expect(doc.description).toBe("push");
    expect(doc.hidden).toBe(true);
  });

  test("four actions parse", () => {
    const doc = parse(`version: v1alpha1
steps:
  - agent: review this
    using: deep-review
  - run: [git, status]
  - herdr: notification.show
    params: { title: done }
  - workflow: gate
    inputs: { suite: unit }
`);
    expect(doc.steps.map((s) => s.action.kind)).toEqual(["agent", "run", "herdr", "workflow"]);
  });

  test("multiple actions rejected", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - run: "true"\n    agent: hi\n`)).toThrow(
      /multiple action keys: agent, run|multiple action keys: run, agent/,
    );
  });

  test("removed keys fail as unknown keys", () => {
    for (const key of ["out", "wait", "in", "ratio", "allow_fail", "for", "as"]) {
      expect(() => parse(`version: v1alpha1\nsteps:\n  - run: "true"\n    ${key}: x\n`)).toThrow(
        new RegExp(`Unrecognized key: "${key}"`),
      );
    }
  });

  test("shell templates rejected", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - run: "echo {{inputs.base}}"\n`)).toThrow(
      /templates are not allowed in shell command text/,
    );
  });

  test("argv templates accepted", () => {
    const doc = parse(
      `version: v1alpha1\ninputs:\n  base: text\nsteps:\n  - run: [git, checkout, "{{inputs.base}}"]\n`,
    );
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { form: "argv", argv: ["git", "checkout", "{{inputs.base}}"] },
    });
  });

  test("shell on argv rejected", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - run: [git, status]\n    shell: bash\n`),
    ).toThrow(/argv form does not use a shell/);
  });

  test("explicit shell", () => {
    const doc = parse(`version: v1alpha1\nsteps:\n  - run: Get-ChildItem\n    shell: pwsh\n`);
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      payload: { form: "shell", shell: "pwsh", command: "Get-ChildItem" },
    });
  });

  test("agent using and target exclusive", () => {
    expect(() =>
      parse(
        `version: v1alpha1\nsteps:\n  - agent: hi\n    using: a\n    target: "{{context.agent}}"\n`,
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("target rejects pane", () => {
    expect(() =>
      parse(
        `version: v1alpha1\nsteps:\n  - agent: hi\n    target: x\n    pane:\n      open: tab\n`,
      ),
    ).toThrow(/target: rejects pane/);
  });

  test("pane size bounds", () => {
    expect(() =>
      parse(`version: v1alpha1
steps:
  - run: sleep 1
    pane:
      open: beside
      size: 100
    background: true
`),
    ).toThrow(/<=99|size/);
  });

  test("pane open required fields", () => {
    const doc = parse(`version: v1alpha1
steps:
  - run: sleep 1
    pane:
      open: beside
      size: 40
      target: "{{context.pane}}"
    ready_when: /listening/
    timeout: 30s
`);
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      readyWhen: "listening",
      timeoutMs: 30_000,
      pane: { open: "beside", size: 40, target: "{{context.pane}}" },
    });
  });

  test("run rejects pane.close", () => {
    expect(() =>
      parse(`version: v1alpha1
steps:
  - run: sleep 1
    pane:
      open: tab
      close: always
    background: true
`),
    ).toThrow(/run: rejects pane.close/);
  });

  test("tab rejects target", () => {
    expect(() =>
      parse(`version: v1alpha1
steps:
  - agent: hi
    pane:
      open: tab
      target: "{{context.pane}}"
`),
    ).toThrow(/pane.target applies only to beside\/below/);
  });

  test("ready_when requires timeout and pane", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - run: sleep 1\n    ready_when: /ok/\n`),
    ).toThrow(/ready_when/);
  });

  test("ready_when flagless validation", () => {
    expect(() =>
      parse(`version: v1alpha1
steps:
  - run: sleep 1
    pane: { open: tab }
    ready_when: //
    timeout: 1s
`),
    ).toThrow(/ready_when/);
  });

  test("duration grammar", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("2s")).toBe(2000);
    expect(parseDurationMs("3m")).toBe(180_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(() => parseDurationMs("0s")).toThrow(/duration/);
    expect(() => parseDurationMs("5")).toThrow(/duration/);
  });

  test("retry attempts and delay", () => {
    const doc = parse(`version: v1alpha1
steps:
  - run: "true"
    retry:
      attempts: 3
      delay: 250ms
`);
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      retry: { attempts: 3, delayMs: 250 },
    });
  });

  test("agent rejects retry as unknown key", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - agent: hi\n    retry:\n      attempts: 2\n`),
    ).toThrow(/Unrecognized key: "retry"/);
  });

  test("when truthiness and equality", () => {
    const doc = parse(`version: v1alpha1
steps:
  - run: "true"
    when: "{{inputs.x}}"
  - run: "true"
    when: '{{context.platform}} == "windows"'
  - run: "true"
    when: '{{context.platform}} != "linux"'
`);
    expect(doc.steps[0]!.when).toEqual({ kind: "truthy", path: "inputs.x" });
    expect(doc.steps[1]!.when).toEqual({
      kind: "eq",
      path: "context.platform",
      value: "windows",
      negate: false,
    });
    expect(doc.steps[2]!.when).toEqual({
      kind: "eq",
      path: "context.platform",
      value: "linux",
      negate: true,
    });
  });

  test("when arbitrary expression rejected", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - run: "true"\n    when: "test -n x"\n`),
    ).toThrow(/when/);
  });

  test("on_failure single recovery action", () => {
    const doc = parse(`version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: failed }
steps:
  - run: "true"
`);
    expect(doc.onFailure).toMatchObject({ kind: "herdr", method: "notification.show" });
  });

  test("on_failure rejects background", () => {
    expect(() =>
      parse(`version: v1alpha1
on_failure:
  run: "true"
  background: true
  pane: { open: tab }
steps:
  - run: "true"
`),
    ).toThrow(/on_failure rejects background/);
  });

  test("returns template and map", () => {
    const whole = parse(
      `version: v1alpha1\nreturns: "{{steps.a}}"\nsteps:\n  - id: a\n    run: "true"\n`,
    );
    expect(whole.returns).toEqual({ kind: "template", template: "{{steps.a}}" });
    const mapped = parse(
      `version: v1alpha1\nreturns:\n  findings: "{{steps.a}}"\nsteps:\n  - id: a\n    run: "true"\n`,
    );
    expect(mapped.returns).toEqual({ kind: "map", fields: { findings: "{{steps.a}}" } });
  });

  test("inputs forms", () => {
    const doc = parse(`version: v1alpha1
inputs:
  note: text
  role: profile
  branch: [main, develop]
  pick:
    type: choice
    options: [a, b]
    default: a
steps:
  - run: [echo, "{{inputs.note}}"]
`);
    expect(doc.inputs?.note).toBe("text");
    expect(doc.inputs?.role).toBe("profile");
    expect(doc.inputs?.branch).toEqual(["main", "develop"]);
  });

  test("denied herdr method", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - herdr: server.stop\n`)).toThrow(/server/);
  });

  test("unknown herdr method", () => {
    expect(() =>
      parse(
        `version: v1alpha1\nsteps:\n  - herdr: pane.splitt\n    params: { direction: right }\n`,
      ),
    ).toThrow(/unknown herdr method/);
  });

  test("dotted keys are not actions", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - pane.split: { direction: right }\n`),
    ).toThrow(/no action key|Unrecognized key/);
  });

  test("unknown template root rejected", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - agent: "see {{foo.bar}}"\n`)).toThrow(
      /invalid template '\{\{foo\.bar\}\}'/,
    );
  });

  test("near-miss template roots rejected", () => {
    expect(() =>
      parse(
        `version: v1alpha1\ninputs:\n  base: text\nsteps:\n  - run: [echo, "{{input.base}}"]\n`,
      ),
    ).toThrow(/invalid template '\{\{input\.base\}\}'/);
    expect(() => parse(`version: v1alpha1\nsteps:\n  - agent: "{{step.diff}}"\n`)).toThrow(
      /invalid template '\{\{step\.diff\}\}'/,
    );
  });

  test("bare template root without path rejected", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - agent: "{{steps}}"\n`)).toThrow(
      /invalid template '\{\{steps\}\}'/,
    );
  });

  test("unclosed template rejected", () => {
    expect(() => parse(`version: v1alpha1\nsteps:\n  - agent: "see {{inputs.base"\n`)).toThrow(
      /invalid template '\{\{inputs\.base'/,
    );
  });

  test("malformed when template names the bad mustache", () => {
    expect(() =>
      parse(`version: v1alpha1\nsteps:\n  - run: "true"\n    when: "{{stepz.x}}"\n`),
    ).toThrow(/invalid template '\{\{stepz\.x\}\}'/);
  });

  test("valid templates and JSON single braces still parse", () => {
    const doc = parse(`version: v1alpha1
inputs:
  base: text
steps:
  - id: probe
    run: [echo, "{{inputs.base}}", '{"key": "value"}']
  - agent: "review {{steps.probe.stdout}} with {\\"a\\":1}"
  - herdr: notification.show
    params:
      title: "{{inputs.base}}"
      body: '{"ok": true}'
  - workflow: gate
    inputs:
      suite: "{{inputs.base}}"
returns: "{{steps.probe}}"
`);
    expect(doc.steps).toHaveLength(4);
    expect(doc.returns).toEqual({ kind: "template", template: "{{steps.probe}}" });
  });

  test("on_failure templates are validated", () => {
    expect(() =>
      parse(`version: v1alpha1
on_failure:
  agent: "failed {{foo.bar}}"
steps:
  - run: "true"
`),
    ).toThrow(/on_failure\.agent.*invalid template/);
  });
});

describe("typed templates", () => {
  test("path parsing", () => {
    expect(parseTemplatePath("steps.assess.response")).toEqual({
      root: "steps",
      segments: ["assess", "response"],
    });
    expect(parseTemplatePath("prompt")).toBeUndefined();
    expect(parseTemplatePath("inputs")).toBeUndefined();
    expect(parseTemplatePath("inputs.base")).toEqual({ root: "inputs", segments: ["base"] });
  });

  test("whole-value vs embedded", () => {
    expect(isWholeValueTemplate("{{steps.a}}")).toBe(true);
    expect(isWholeValueTemplate("x {{steps.a}}")).toBe(false);
  });

  test("canonical scalar rendering", () => {
    expect(renderScalar("hi")).toBe("hi");
    expect(renderScalar(true)).toBe("true");
    expect(renderScalar(false)).toBe("false");
    expect(renderScalar(1.5)).toBe("1.5");
    expect(renderScalar(null)).toBe("");
    expect(renderScalar({ a: 1 })).toBe('{"a":1}');
    expect(renderScalar([1, 2])).toBe("[1,2]");
  });

  test("text and structured substitution", () => {
    const ns: TemplateNamespace = {
      ...emptyNs,
      inputs: { base: "main" },
      steps: { review: { response: "ok", agent: { name: "claude" }, pane_id: "p1" } },
    };
    expect(substituteText("branch {{inputs.base}}", ns)).toBe("branch main");
    expect(substituteValue("{{steps.review}}", ns)).toEqual({
      response: "ok",
      agent: { name: "claude" },
      pane_id: "p1",
    });
    expect(substituteValue("got {{steps.review.response}}", ns)).toBe("got ok");
  });

  test("params substitution preserves structure", () => {
    const ns: TemplateNamespace = {
      ...emptyNs,
      steps: { create: { pane_id: "p9" } },
      inputs: { n: 3 },
    };
    expect(
      substituteParams(
        { pane_id: "{{steps.create.pane_id}}", nested: { count: "{{inputs.n}}" }, flag: true },
        ns,
      ),
    ).toEqual({ pane_id: "p9", nested: { count: 3 }, flag: true });
  });

  test("JSON braces pass through", () => {
    expect(substituteText('{"key": "value"}', emptyNs)).toBe('{"key": "value"}');
  });

  test("textTemplates finds refs", () => {
    expect(textTemplates("{{inputs.a}} and {{steps.b.c}}")).toEqual([
      { root: "inputs", segments: ["a"] },
      { root: "steps", segments: ["b", "c"] },
    ]);
  });
});

describe("loader references and composition", () => {
  test("duplicate and forward step ids", async () => {
    await expect(
      parseWorkflowText(
        "dup",
        `version: v1alpha1\nsteps:\n  - id: a\n    run: "true"\n  - id: a\n    run: "true"\n`,
      ),
    ).rejects.toThrow(/duplicate step id 'a'/);

    await expect(
      parseWorkflowText(
        "fwd",
        `version: v1alpha1\nsteps:\n  - run: [echo, "{{steps.later.stdout}}"]\n  - id: later\n    run: [echo, hi]\n`,
      ),
    ).rejects.toThrow(/forward reference to step 'later'/);
  });

  test("background when and tolerated non-command results rejected", async () => {
    await expect(
      parseWorkflowText(
        "bg",
        `version: v1alpha1\nsteps:\n  - id: launch\n    run: sleep 1\n    background: true\n    pane: { open: tab }\n  - run: [echo, "{{steps.launch.pane_id}}"]\n`,
      ),
    ).rejects.toThrow(/background steps produce no result/);

    await expect(
      parseWorkflowText(
        "skip",
        `version: v1alpha1\nsteps:\n  - id: maybe\n    run: [echo, hi]\n    when: "{{inputs.flag}}"\n  - run: [echo, "{{steps.maybe.stdout}}"]\n`,
      ),
    ).rejects.toThrow(/unknown input 'flag'|may be skipped by when/);

    await expect(
      parseWorkflowText(
        "skip2",
        `version: v1alpha1\ninputs:\n  flag: text\nsteps:\n  - id: maybe\n    run: [echo, hi]\n    when: "{{inputs.flag}}"\n  - run: [echo, "{{steps.maybe.stdout}}"]\n`,
      ),
    ).rejects.toThrow(/may be skipped by when/);

    await expect(
      parseWorkflowText(
        "tol-agent",
        `version: v1alpha1\nsteps:\n  - id: ask\n    agent: hi\n    continue_on_error: true\n  - run: [echo, "{{steps.ask.response}}"]\n`,
      ),
    ).rejects.toThrow(/continue_on_error step may fail without a natural result/);

    const ok = await parseWorkflowText(
      "tol-cmd",
      `version: v1alpha1\nsteps:\n  - id: probe\n    run: [sh, -c, "exit 1"]\n    continue_on_error: true\n  - run: [echo, "{{steps.probe.exit_code}}"]\n`,
    );
    expect(ok.steps).toHaveLength(2);
  });

  test("managed agent and herdr result fields", async () => {
    const agent = await parseWorkflowText(
      "agent",
      `version: v1alpha1\nsteps:\n  - id: review\n    agent: look\n  - run: [echo, "{{steps.review.response}}", "{{steps.review.pane_id}}"]\n`,
    );
    expect(agent.steps).toHaveLength(2);

    await expect(
      parseWorkflowText(
        "bad-agent",
        `version: v1alpha1\nsteps:\n  - id: review\n    agent: look\n  - run: [echo, "{{steps.review.stdout}}"]\n`,
      ),
    ).rejects.toThrow(/unknown managed agent result field/);

    const herdr = await parseWorkflowText(
      "herdr",
      `version: v1alpha1\nsteps:\n  - id: tree\n    herdr: worktree.create\n    params: { cwd: /repo }\n  - run: [echo, "{{steps.tree.worktree.path}}"]\n`,
    );
    expect(herdr.steps).toHaveLength(2);

    await expect(
      parseWorkflowText(
        "bad-herdr",
        `version: v1alpha1\nsteps:\n  - id: tree\n    herdr: worktree.create\n    params: { cwd: /repo }\n  - run: [echo, "{{steps.tree.not_a_field}}"]\n`,
      ),
    ).rejects.toThrow(/unknown herdr result field/);

    await expect(
      parseWorkflowText(
        "split-focus",
        `version: v1alpha1\nsteps:\n  - herdr: pane.split\n    params: { direction: right }\n`,
      ),
    ).rejects.toThrow(/target_pane_id is required/);

    await expect(
      parseWorkflowText(
        "worktree-templated-branch",
        `version: v1alpha1\nsteps:\n  - herdr: worktree.create\n    params: { branch: "{{inputs.branch}}" }\n`,
      ),
    ).rejects.toThrow(/needs exactly one of workspace_id or cwd/);

    await expect(
      parseWorkflowText(
        "tab-templated-label",
        `version: v1alpha1\nsteps:\n  - herdr: tab.create\n    params: { label: "{{inputs.l}}" }\n`,
      ),
    ).rejects.toThrow(/params.workspace_id is required/);

    const templatedEnum = await parseWorkflowText(
      "split-templated-direction",
      `version: v1alpha1\ninputs:\n  d: text\nsteps:\n  - herdr: pane.split\n    params: { direction: "{{inputs.d}}", target_pane_id: w1:p1 }\n`,
    );
    expect(templatedEnum.steps[0]?.action).toMatchObject({
      kind: "herdr",
      method: "pane.split",
    });
  });

  test("child returns isolation cycles and required inputs", async () => {
    const { root, config } = await repoWith({
      inspect: `version: v1alpha1
inputs:
  base: text
returns:
  findings: "{{steps.review}}"
steps:
  - id: review
    agent: "review {{inputs.base}}"
`,
      parent: `version: v1alpha1
inputs:
  base: text
steps:
  - id: inspection
    workflow: inspect
    inputs:
      base: "{{inputs.base}}"
  - run: [echo, "{{steps.inspection.findings.response}}"]
`,
      leak: `version: v1alpha1
steps:
  - run: [echo, "{{steps.diff.stdout}}"]
`,
      bare: `version: v1alpha1
steps:
  - run: "true"
`,
      uses_bare: `version: v1alpha1
steps:
  - id: child
    workflow: bare
  - run: [echo, "{{steps.child}}"]
`,
      a: `version: v1alpha1
steps:
  - workflow: b
`,
      b: `version: v1alpha1
steps:
  - workflow: a
`,
      needs: `version: v1alpha1
inputs:
  suite: text
steps:
  - run: [echo, "{{inputs.suite}}"]
`,
      missing: `version: v1alpha1
steps:
  - workflow: needs
`,
      typed: `version: v1alpha1
inputs:
  n: text
steps:
  - run: [echo, "{{inputs.n}}"]
`,
      bad_type: `version: v1alpha1
steps:
  - id: probe
    run: [echo, hi]
  - workflow: typed
    inputs:
      n: "{{steps.probe}}"
`,
    });

    const parent = await loadWorkflow("parent", root, config);
    expect(parent.steps[0]?.action).toMatchObject({ kind: "workflow", name: "inspect" });

    await expect(loadWorkflow("leak", root, config)).rejects.toThrow(/unknown step id 'diff'/);
    await expect(loadWorkflow("uses_bare", root, config)).rejects.toThrow(
      /child workflow declares no returns/,
    );
    await expect(loadWorkflow("a", root, config)).rejects.toThrow(/workflow cycle: a → b → a/);
    await expect(loadWorkflow("missing", root, config)).rejects.toThrow(
      /missing required child input 'suite'/,
    );
    await expect(loadWorkflow("bad_type", root, config)).rejects.toThrow(
      /must resolve to text \(source type object\)/,
    );
  });

  test("returns reject transcript and require whole-value templates", async () => {
    await expect(
      parseWorkflowText(
        "ret",
        `version: v1alpha1\nreturns: "{{context.transcript}}"\nsteps:\n  - run: "true"\n`,
      ),
    ).rejects.toThrow(/cannot reference context\.transcript/);

    expect(() =>
      parse(
        `version: v1alpha1\nreturns: "x {{steps.a.stdout}}"\nsteps:\n  - id: a\n    run: "true"\n`,
      ),
    ).toThrow(/must be a whole-value template/);
  });

  test("herdr result fields are method-scoped", async () => {
    await expect(
      parseWorkflowText(
        "cross-method",
        `version: v1alpha1\nsteps:\n  - id: notify\n    herdr: notification.show\n    params: { title: done }\n  - run: [echo, "{{steps.notify.worktree.path}}"]\n`,
      ),
    ).rejects.toThrow(/unknown herdr result field 'worktree\.path'/);

    const ok = await parseWorkflowText(
      "notify-ok",
      `version: v1alpha1\nsteps:\n  - id: notify\n    herdr: notification.show\n    params: { title: done }\n  - run: [echo, "{{steps.notify.shown}}"]\n`,
    );
    expect(ok.steps).toHaveLength(2);
  });

  test("readiness result fields follow pane.wait_for_output plus created ids", async () => {
    const ok = await parseWorkflowText(
      "ready-ok",
      `version: v1alpha1\nsteps:\n  - id: boot\n    run: [echo, ready]\n    pane: { open: tab }\n    ready_when: "/ready/"\n    timeout: 5s\n  - run: [echo, "{{steps.boot.matched_line}}", "{{steps.boot.pane_id}}", "{{steps.boot.tab_id}}"]\n`,
    );
    expect(ok.steps).toHaveLength(2);

    await expect(
      parseWorkflowText(
        "ready-bad",
        `version: v1alpha1\nsteps:\n  - id: boot\n    run: [echo, ready]\n    pane: { open: tab }\n    ready_when: "/ready/"\n    timeout: 5s\n  - run: [echo, "{{steps.boot.worktree.path}}"]\n`,
      ),
    ).rejects.toThrow(/unknown readiness result field 'worktree\.path'/);
  });

  test("context.error is recovery-only", async () => {
    await expect(
      parseWorkflowText(
        "err-step",
        `version: v1alpha1\nsteps:\n  - run: [echo, "{{context.error.message}}"]\n`,
      ),
    ).rejects.toThrow(/context\.error is only available inside on_failure/);

    await expect(
      parseWorkflowText(
        "err-returns",
        `version: v1alpha1\nreturns: "{{context.error}}"\nsteps:\n  - run: "true"\n`,
      ),
    ).rejects.toThrow(/context\.error is only available inside on_failure/);

    const ok = await parseWorkflowText(
      "err-recovery",
      `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: "{{context.error.message}}" }
steps:
  - run: "true"
`,
    );
    expect(ok.onFailure).toMatchObject({ kind: "herdr", method: "notification.show" });
  });

  test("literal using profile must exist; templates defer", async () => {
    await expect(
      parseWorkflowText(
        "bad-using",
        `version: v1alpha1\nsteps:\n  - agent: hi\n    using: nonexistent\n`,
      ),
    ).rejects.toThrow(/unknown profile 'nonexistent'/);

    const withProfile: WorkflowsConfig = {
      profiles: { review: { kind: "claude" } },
      transcripts: {},
    };
    const ok = await parseWorkflowText(
      "good-using",
      `version: v1alpha1\nsteps:\n  - agent: hi\n    using: review\n`,
      withProfile,
    );
    expect(ok.steps[0]?.action).toMatchObject({ kind: "agent", using: "review" });

    const templated = await parseWorkflowText(
      "tmpl-using",
      `version: v1alpha1\ninputs:\n  role: text\nsteps:\n  - agent: hi\n    using: "{{inputs.role}}"\n`,
    );
    expect(templated.steps[0]?.action).toMatchObject({ kind: "agent", using: "{{inputs.role}}" });
  });

  test("action template errors name the precise key", async () => {
    await expect(
      parseWorkflowText(
        "bad-cwd",
        `version: v1alpha1\nsteps:\n  - run: [echo, hi]\n    cwd: "{{steps.missing.stdout}}"\n`,
      ),
    ).rejects.toThrow(/\.cwd:.*unknown step id 'missing'|cwd:.*unknown step id 'missing'/);

    await expect(
      parseWorkflowText(
        "bad-env",
        `version: v1alpha1\nsteps:\n  - run: [echo, hi]\n    env: { FOO: "{{steps.missing.stdout}}" }\n`,
      ),
    ).rejects.toThrow(/env\.FOO:.*unknown step id 'missing'/);

    await expect(
      parseWorkflowText(
        "bad-run",
        `version: v1alpha1\nsteps:\n  - run: [echo, "{{steps.missing.stdout}}"]\n`,
      ),
    ).rejects.toThrow(/run\[1\]:.*unknown step id 'missing'/);
  });
});
