import { describe, expect, test } from "bun:test";
import type { WorkflowListEntry } from "../src/workflow/types";
import {
  buildPickerOptions,
  entrySensitivity,
  filterChoiceOptions,
  filterWorkflowEntries,
  formatInputPrompt,
  formatInvalidLines,
  formatRunProgress,
  hasVisibleEntries,
  LIST_HINT,
  resolveListWorkbenchRoute,
  shouldDropStdinLeakSequence,
  truncate,
} from "../src/tui/picker";
import { humanizeWorkflowName, workflowDisplayTitle } from "../src/workflow/trust";

const entries: WorkflowListEntry[] = [
  {
    name: "chat-handoff",
    source: "repo",
    file: "/r/chat.yaml",
    title: "Chat handoff",
    description: "Pass transcript to a reviewer",
    needsTranscript: true,
    hasCommands: false,
  },
  { name: "deploy", source: "global", file: "/g/deploy.yaml", hasCommands: true },
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
  test("title, provenance, inputs, and sensitivity flags", () => {
    const entry: WorkflowListEntry = {
      name: "handover",
      source: "repo",
      file: "/r/handover.yaml",
      title: "Handover",
      description: "Pick a profile",
      inputs: [{ name: "target", type: "profile", options: ["claude"] }],
      hasCommands: true,
      needsTranscript: true,
      sensitiveMethods: ["pane.close"],
    };
    const options = buildPickerOptions([entry]);
    expect(options[0]!.name).toBe(
      "Handover · repo · inputs · commands · transcript · herdr:pane.close",
    );
    expect(options[0]!.description).toBe("Pick a profile");
  });

  test("humanized title default and provenance badges", () => {
    const { valid } = filterWorkflowEntries(entries, "");
    const options = buildPickerOptions(valid);
    expect(options[0]!.name).toContain("Chat handoff · repo");
    expect(options[0]!.name).toContain("transcript");
    expect(options[0]!.description).toBe("Pass transcript to a reviewer");
    expect(options[1]!.name).toBe("Deploy · global · commands");
    expect(options[1]!.description).toBe("deploy");
  });

  test("profile input options never expose args", () => {
    const entry: WorkflowListEntry = {
      name: "pick",
      source: "global",
      file: "/g/pick.yaml",
      inputs: [{ name: "who", type: "profile", options: ["claude", "codex"] }],
    };
    expect(entry.inputs?.[0]?.options).toEqual(["claude", "codex"]);
    expect(JSON.stringify(entry.inputs)).not.toContain("args");
  });
});

describe("entrySensitivity", () => {
  test("aggregates command transcript and sensitive methods", () => {
    expect(
      entrySensitivity({
        name: "x",
        source: "repo",
        file: "/x",
        hasCommands: true,
        needsTranscript: true,
        sensitiveMethods: ["layout.apply"],
        unresolvedChildren: ["missing"],
      }),
    ).toEqual(["commands", "transcript", "herdr:layout.apply", "unresolved:missing"]);
  });
});

describe("display titles", () => {
  test("humanize filename when title omitted", () => {
    expect(humanizeWorkflowName("chat-handoff")).toBe("Chat Handoff");
    expect(workflowDisplayTitle("chat-handoff")).toBe("Chat Handoff");
    expect(workflowDisplayTitle("chat-handoff", "Custom")).toBe("Custom");
  });
});

describe("formatInvalidLines", () => {
  test("truncates error and returns empty when none", () => {
    expect(formatInvalidLines([], 44)).toBe("");
    const lines = formatInvalidLines([entries[2]!], 44);
    expect(lines).toBe("broken — invalid: step 2, agent: unknown ag…");
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

describe("formatInputPrompt", () => {
  test("names the input, description, and line role", () => {
    expect(formatInputPrompt({ name: "target", type: "profile" })).toBe(
      "target · type to filter, enter to select",
    );
    expect(
      formatInputPrompt({
        name: "target",
        type: "profile",
        description: "Agent to hand off to",
      }),
    ).toBe("target — Agent to hand off to · type to filter, enter to select");
    expect(formatInputPrompt({ name: "focus", type: "text" })).toBe("focus · type free text");
    expect(
      formatInputPrompt({
        name: "branch",
        type: "choice",
        options: ["main"],
        description: "Which branch",
      }),
    ).toBe("branch — Which branch · type to filter, enter to select");
  });
});

describe("truncate", () => {
  test("ellipsis at max", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcd", 5)).toBe("abcd");
  });
});

describe("list workbench shortcuts", () => {
  test("footer identifies run edit share import dismiss", () => {
    expect(LIST_HINT).toContain("enter run");
    expect(LIST_HINT).toContain("^e edit");
    expect(LIST_HINT).toContain("^y share");
    expect(LIST_HINT).toContain("^o import");
    expect(LIST_HINT).toContain("esc");
  });

  test("printable e y o are filter letters not workbench actions", () => {
    const entry: WorkflowListEntry = { name: "deploy", source: "repo", file: "/r/d.yaml" };
    expect(resolveListWorkbenchRoute({ name: "e", ctrl: false }, entry)).toBeUndefined();
    expect(resolveListWorkbenchRoute({ name: "y", ctrl: false }, entry)).toBeUndefined();
    expect(resolveListWorkbenchRoute({ name: "o", ctrl: false }, entry)).toBeUndefined();
  });

  test("ctrl+e and ctrl+y preserve selected repo/global provenance", () => {
    expect(
      resolveListWorkbenchRoute(
        { name: "e", ctrl: true },
        { name: "deploy", source: "repo", file: "/r/d.yaml" },
      ),
    ).toBe("w=repo:deploy");
    expect(
      resolveListWorkbenchRoute(
        { name: "y", ctrl: true },
        { name: "deploy", source: "global", file: "/g/d.yaml" },
      ),
    ).toBe("share=global:deploy");
  });

  test("edit/share noop without selection; import works with empty list", () => {
    expect(resolveListWorkbenchRoute({ name: "e", ctrl: true }, undefined)).toBe("noop");
    expect(resolveListWorkbenchRoute({ name: "y", ctrl: true }, undefined)).toBe("noop");
    expect(resolveListWorkbenchRoute({ name: "o", ctrl: true }, undefined)).toBe("import");
  });
});

describe("stdin leak prepend boundary", () => {
  test("preserves Ctrl+E/O/Y C0 bytes while dropping unrelated prefix leaks", () => {
    expect(shouldDropStdinLeakSequence(String.fromCharCode(0x05))).toBe(false); // Ctrl+E
    expect(shouldDropStdinLeakSequence(String.fromCharCode(0x0f))).toBe(false); // Ctrl+O
    expect(shouldDropStdinLeakSequence(String.fromCharCode(0x19))).toBe(false); // Ctrl+Y
    expect(shouldDropStdinLeakSequence("\t")).toBe(false);
    expect(shouldDropStdinLeakSequence("\n")).toBe(false);
    expect(shouldDropStdinLeakSequence("\r")).toBe(false);
    expect(shouldDropStdinLeakSequence("\x1b")).toBe(false);
    expect(shouldDropStdinLeakSequence("e")).toBe(false);
    expect(shouldDropStdinLeakSequence(String.fromCharCode(0x01))).toBe(true); // Ctrl+A
    expect(shouldDropStdinLeakSequence(String.fromCharCode(0x18))).toBe(true); // Ctrl+X
    expect(shouldDropStdinLeakSequence("ab")).toBe(false);
  });
});
