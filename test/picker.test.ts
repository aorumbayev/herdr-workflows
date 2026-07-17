import { describe, expect, test } from "bun:test";
import type { WorkflowListEntry } from "../src/workflows";
import {
  buildPickerOptions,
  filterWorkflowEntries,
  formatInvalidLines,
  formatRunProgress,
} from "../src/tui/picker-rows";
import { truncate } from "../src/tui/text";

const entries: WorkflowListEntry[] = [
  { name: "chat-handoff", source: "repo", file: "/r/chat.yaml", needsPrompt: true },
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

  test("empty match yields empty lists", () => {
    const { valid, invalid } = filterWorkflowEntries(entries, "zzz");
    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

describe("buildPickerOptions", () => {
  test("single-line name with source; prompt flagged", () => {
    const { valid } = filterWorkflowEntries(entries, "");
    const options = buildPickerOptions(valid);
    expect(options).toEqual([
      {
        name: "chat-handoff · repo · prompt",
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

describe("truncate", () => {
  test("ellipsis at max", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcd", 5)).toBe("abcd");
  });
});
