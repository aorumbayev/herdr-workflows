import { describe, expect, test } from "bun:test";
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
