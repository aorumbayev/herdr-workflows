import { describe, expect, test } from "bun:test";
import { dumpWorkflow } from "../../src/workflow/inputs";
import { parseRaw, rawStepKeyOrder, type RawWorkflowDoc } from "../../src/workflow/grammar";

function roundTrip(doc: RawWorkflowDoc) {
  return parseRaw("buf.yaml", dumpWorkflow(doc));
}

const base = { version: "v1alpha1" as const };

describe("dumpWorkflow round-trips through parseRaw", () => {
  test("YAML-typed scalars stay strings", () => {
    for (const v of [
      "123",
      "1.5",
      "true",
      "True",
      "FALSE",
      "null",
      "~",
      "0x10",
      "1e3",
      ".nan",
      "+7",
    ]) {
      const doc = roundTrip({
        ...base,
        steps: [{ run: `echo ${v}` }],
      });
      expect(doc.steps[0]!.action).toMatchObject({
        kind: "run",
        payload: { form: "shell", command: `echo ${v}` },
      });
      const run = roundTrip({ ...base, steps: [{ run: v }] });
      expect(run.steps[0]!.action).toMatchObject({
        kind: "run",
        payload: { form: "shell", command: v },
      });
    }
  });

  test("trailing colon and mapping/comment traps are quoted", () => {
    for (const v of ["note:", "a: b", "has # hash", "# leading", "- dash"]) {
      const doc = roundTrip({ ...base, steps: [{ run: v }] });
      expect(doc.steps[0]!.action).toMatchObject({
        kind: "run",
        payload: { form: "shell", command: v },
      });
    }
  });

  test("multi-line values round-trip byte-exact", () => {
    const cases = ["line1  \nline2", "foo\n\n\n", "  indented\nok", "a\nb", 'quote "me"\nnow'];
    for (const v of cases) {
      const doc = roundTrip({ ...base, steps: [{ agent: v }] });
      expect(doc.steps[0]!.action).toMatchObject({ kind: "agent", prompt: v });
    }
  });

  test("input values that look like YAML scalars stay strings", () => {
    const doc = roundTrip({
      ...base,
      inputs: {
        target: { description: "pick: one" },
        plain: { default: "true" },
      },
      steps: [{ run: "echo hi" }],
    });
    expect(doc.inputs?.target).toMatchObject({ description: "pick: one" });
    expect(doc.inputs?.plain).toMatchObject({ default: "true" });
  });

  test("adaptive input fields survive workbench formatting", () => {
    const doc = roundTrip({
      ...base,
      inputs: {
        mode: ["create", "delete"],
        branch: {
          type: "choice",
          options: ["main"],
          when: '{{inputs.mode}} == "create"',
          allow_custom: true,
          min_length: 1,
        },
      },
      steps: [
        {
          run: ["echo", "{{inputs.branch}}"],
          when: '{{inputs.mode}} == "create"',
        },
      ],
    });
    expect(doc.inputs?.branch).toMatchObject({
      allow_custom: true,
      min_length: 1,
      when: '{{inputs.mode}} == "create"',
    });
  });

  test("on_failure herdr with nested params round-trips", () => {
    const text = dumpWorkflow({
      ...base,
      steps: [{ run: "echo hi" }],
      on_failure: {
        herdr: "notification.show",
        params: {
          title: "handoff failed",
          body: "{{context.error.message}}",
          sound: "request",
        },
      },
    });
    expect(text).toMatch(/\non_failure:\n {2}herdr:/);
    expect(text).toMatch(/\n {2}params:/);
    expect(text).not.toMatch(/\non_failure:\n {2}- /);
    const doc = parseRaw("buf.yaml", text);
    expect(doc.onFailure).toMatchObject({
      kind: "herdr",
      method: "notification.show",
      params: {
        title: "handoff failed",
        body: "{{context.error.message}}",
        sound: "request",
      },
    });
  });

  test("parse(dump(doc)) preserves every schema step key", () => {
    expect(rawStepKeyOrder).toEqual(
      expect.arrayContaining([
        "id",
        "when",
        "continue_on_error",
        "run",
        "cwd",
        "env",
        "timeout",
        "retry",
        "success_codes",
        "background",
      ]),
    );
    const step = {
      id: "shell",
      run: ["echo", "hi"],
      when: '{{inputs.mode}} == "go"',
      continue_on_error: true,
      cwd: "/tmp",
      env: { FLAG: "1" },
      timeout: "5s",
      retry: { attempts: 2, delay: "1s" },
      success_codes: [0, 2],
    } satisfies RawWorkflowDoc["steps"][number];
    const text = dumpWorkflow({
      ...base,
      inputs: { mode: ["go", "skip"] },
      steps: [step],
    });
    for (const key of Object.keys(step)) {
      expect(text).toContain(`${key}:`);
    }
    const doc = roundTrip({
      ...base,
      inputs: { mode: ["go", "skip"] },
      steps: [step],
    });
    expect(doc.steps[0]).toMatchObject({
      id: "shell",
      continueOnError: true,
      action: {
        kind: "run",
        payload: { form: "argv", argv: ["echo", "hi"] },
        cwd: "/tmp",
        env: { FLAG: "1" },
        timeoutMs: 5000,
        retry: { attempts: 2, delayMs: 1000 },
        successCodes: [0, 2],
      },
    });
    expect(doc.steps[0]!.when).toEqual([
      { kind: "eq", negate: false, path: "inputs.mode", value: "go" },
    ]);
  });
});
