import { describe, expect, test } from "bun:test";
import { parseRaw } from "../src/workflow/parse";
import { dumpWorkflow } from "../src/web/server";
import type { RawWorkflowDoc } from "../src/workflow/parse";

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
});
