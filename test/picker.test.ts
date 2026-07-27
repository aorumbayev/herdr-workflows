import { describe, expect, test } from "bun:test";
import type { WorkflowListEntry } from "../src/workflow/types";
import {
  buildPickerOptions,
  filterChoiceOptions,
  filterWorkflowEntries,
  formatInvalidLines,
  formatRunProgress,
  hasVisibleEntries,
} from "../src/tui/picker";
import { truncate } from "../src/tui/picker";

const entries: WorkflowListEntry[] = [
  { name: "chat-handoff", source: "repo", file: "/r/chat.yaml", needsTranscript: true },
  { name: "deploy", source: "global", file: "/g/deploy.yaml" },
  {
    name: "broken",
    source: "repo",
    file: "/r/broken.yaml",
    error: "/r/broken.yaml, step 2, agent: unknown agent 'x'",
  },
  {
    name: "chat-broken",
    source: "global",
    file: "/g/chat-broken.yaml",
    error: "cycle",
  },
];

describe("filterWorkflowEntries", () => {
  test("splits valid and invalid", () => {
    const { valid, invalid } = filterWorkflowEntries(entries, "");
    expect(valid.map((e) => e.name)).toEqual(["chat-handoff", "deploy"]);
    expect(invalid.map((e) => e.name)).toEqual(["broken", "chat-broken"]);
  });

  test("substring filter applies to both", () => {
    const { valid, invalid } = filterWorkflowEntries(entries, "chat");
    expect(valid.map((e) => e.name)).toEqual(["chat-handoff"]);
    expect(invalid.map((e) => e.name)).toEqual(["chat-broken"]);
  });

  test("hidden workflows are kept out of the picker", () => {
    const withBg: WorkflowListEntry[] = [
      ...entries,
      { name: "ship-bg", source: "repo", file: "/r/ship-bg.yaml", hidden: true },
      { name: "broken-bg", source: "repo", file: "/r/broken-bg.yaml", hidden: true, error: "boom" },
    ];
    const { valid, invalid } = filterWorkflowEntries(withBg, "");
    expect(valid.map((e) => e.name)).toEqual(["chat-handoff", "deploy"]);
    expect(invalid.map((e) => e.name)).toEqual(["broken", "chat-broken"]);
    expect(filterWorkflowEntries(withBg, "bg").valid).toEqual([]);
  });

  test("hasVisibleEntries is false when every workflow is hidden", () => {
    const hidden: WorkflowListEntry[] = [
      { name: "ship-bg", source: "repo", file: "/r/ship-bg.yaml", hidden: true },
      { name: "broken-bg", source: "repo", file: "/r/broken-bg.yaml", hidden: true, error: "boom" },
    ];
    expect(hasVisibleEntries(hidden)).toBe(false);
    expect(hasVisibleEntries([])).toBe(false);
    expect(hasVisibleEntries([...hidden, entries[0]!])).toBe(true);
  });
});

describe("buildPickerOptions", () => {
  test("inputs flagged in row suffix", () => {
    const entry: WorkflowListEntry = {
      name: "handover",
      source: "repo",
      file: "/r/handover.yaml",
      inputs: [{ name: "target", type: "choice", options: ["claude"] }],
    };
    const options = buildPickerOptions([entry]);
    expect(options[0]!.name).toBe("handover · repo · inputs");
  });

  test("single-line name with source; transcript flagged", () => {
    const { valid } = filterWorkflowEntries(entries, "");
    const options = buildPickerOptions(valid);
    expect(options).toEqual([
      {
        name: "chat-handoff · repo · transcript",
        description: "",
        value: { entry: entries[0]! },
      },
      {
        name: "deploy · global",
        description: "",
        value: { entry: entries[1]! },
      },
    ]);
  });
});

describe("formatInvalidLines", () => {
  test("truncates error and returns empty when none", () => {
    expect(formatInvalidLines([])).toBe("");
    const lines = formatInvalidLines([entries[2]!]);
    expect(lines).toBe("broken — invalid: step 2, agent: unknown agent 'x'");
  });
});

describe("formatRunProgress", () => {
  test("pending shows ellipsis; terminal appends status", () => {
    expect(formatRunProgress("handoff", [])).toBe("handoff\n…");
    expect(formatRunProgress("handoff", ["[1/2] shell"])).toBe("handoff\n[1/2] shell");
    expect(formatRunProgress("handoff", ["[1/1] shell"], { ok: true, detail: "" })).toBe(
      "handoff\n[1/1] shell\n\nDone.",
    );
    expect(formatRunProgress("handoff", ["[1/1] shell"], { ok: false, detail: "boom" })).toBe(
      "handoff\n[1/1] shell\n\nFailed · boom",
    );
  });
});

describe("filterChoiceOptions", () => {
  test("substring filter; empty filter keeps all", () => {
    const options = ["main", "feat/workflow-inputs", "fix/token"];
    expect(filterChoiceOptions(options, "")).toEqual(options);
    expect(filterChoiceOptions(options, "feat")).toEqual(["feat/workflow-inputs"]);
    expect(filterChoiceOptions(options, "zzz")).toEqual([]);
  });
});

describe("truncate", () => {
  test("ellipsis at max", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcd", 5)).toBe("abcd");
  });
});
