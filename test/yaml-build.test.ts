import { describe, expect, test } from "bun:test";
import { dumpWorkflow } from "../src/web/yaml-build";
import { parseRaw, type RawWorkflow } from "../src/workflows";

function roundtrip(doc: RawWorkflow): RawWorkflow {
  return parseRaw("t.yaml", dumpWorkflow(doc));
}

describe("dumpWorkflow", () => {
  test("placeholder value is quoted so it parses as a string, not a flow map", () => {
    const yaml = dumpWorkflow({ steps: [{ shell: "echo hi", stdin: "{pane}" }] });
    expect(yaml).toContain('stdin: "{pane}"');
    expect(parseRaw("t.yaml", yaml).steps[0]).toEqual({ shell: "echo hi", stdin: "{pane}" });
  });

  test("blank line separates steps for readability", () => {
    const yaml = dumpWorkflow({ steps: [{ shell: "a" }, { shell: "b" }] });
    expect(yaml).toBe("steps:\n  - shell: a\n\n  - shell: b\n");
  });

  test("multi-line prompt becomes a literal block scalar", () => {
    const doc: RawWorkflow = { steps: [{ agent: "claude", prompt: "line one\nline two" }] };
    const yaml = dumpWorkflow(doc);
    expect(yaml).toContain("prompt: |");
    expect(roundtrip(doc).steps[0]).toEqual({ agent: "claude", prompt: "line one\nline two" });
  });

  test("inputs, modifiers and on_fail survive a round-trip", () => {
    const doc: RawWorkflow = {
      inputs: { target: { label: "Agent", options: ["claude", "codex"], default: "claude" } },
      steps: [
        { open: "lazygit", wait_for: "ready", timeout: 30 },
        { agent: "claude", prompt: "go", wait: "done", timeout: 600, close_source: true },
        { herdr: "pane.focus", params: { id: 2 } },
        { run: "other" },
      ],
      on_fail: "cleanup",
    };
    expect(roundtrip(doc)).toEqual(doc);
  });
});
