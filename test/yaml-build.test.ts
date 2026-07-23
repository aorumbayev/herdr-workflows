import { describe, expect, test } from "bun:test";
import { parseRaw } from "../src/workflows";
import { dumpWorkflow } from "../src/web/yaml-build";

function roundTrip(doc: Parameters<typeof dumpWorkflow>[0]) {
  return parseRaw("buf.yaml", dumpWorkflow(doc));
}

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
      const doc = roundTrip({ steps: [{ shell: `echo ${v}` }] });
      expect(doc.steps[0]!.shell).toBe(`echo ${v}`);
      const run = roundTrip({ steps: [{ run: v }] });
      expect(run.steps[0]!.run).toBe(v);
    }
  });

  test("trailing colon and mapping/comment traps are quoted", () => {
    for (const v of ["note:", "a: b", "has # hash", "# leading", "- dash"]) {
      const doc = roundTrip({ steps: [{ shell: v }] });
      expect(doc.steps[0]!.shell).toBe(v);
    }
  });

  test("multi-line values round-trip byte-exact", () => {
    const cases = ["line1  \nline2", "foo\n\n\n", "  indented\nok", "a\nb", 'quote "me"\nnow'];
    for (const v of cases) {
      const doc = roundTrip({ steps: [{ agent: "claude", prompt: v }] });
      expect(doc.steps[0]!.prompt).toBe(v);
    }
  });

  test("input values that look like YAML scalars stay strings", () => {
    const doc = roundTrip({
      inputs: { target: { label: "pick: one" }, plain: { default: "true" } },
      steps: [{ shell: "echo hi" }],
    });
    expect(doc.inputs?.target?.label).toBe("pick: one");
    expect(doc.inputs?.plain?.default).toBe("true");
  });
});
