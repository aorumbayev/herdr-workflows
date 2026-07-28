import { describe, expect, test } from "bun:test";
import type { WorkflowListEntry } from "../src/workflow/types";
import {
  buildInvalidOptions,
  buildPickerOptions,
  entrySensitivity,
  filterChoiceOptions,
  filterWorkflowEntries,
  formatDetailLine,
  formatInputPrompt,
  formatListFooter,
  formatPickerRowName,
  formatRule,
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

const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);
const hasAmbiguousChromeGlyph = (s: string) => /[↑↓←→▲▼◀▶━═]/.test(s);

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

  test("matches displayed title case-insensitively", () => {
    const catalog: WorkflowListEntry[] = [
      {
        name: "pr-desc",
        source: "repo",
        file: "/r/pr-desc.yaml",
        title: "Draft PR description",
      },
      { name: "handoff", source: "global", file: "/g/handoff.yaml", title: "Handoff" },
    ];
    expect(filterWorkflowEntries(catalog, "draft").valid.map((e) => e.name)).toEqual(["pr-desc"]);
    expect(filterWorkflowEntries(catalog, "HANDOFF").valid.map((e) => e.name)).toEqual(["handoff"]);
  });

  test("matches name when title differs", () => {
    const catalog: WorkflowListEntry[] = [
      {
        name: "pr-desc",
        source: "repo",
        file: "/r/pr-desc.yaml",
        title: "Draft PR description",
      },
    ];
    expect(filterWorkflowEntries(catalog, "pr-desc").valid.map((e) => e.name)).toEqual(["pr-desc"]);
    expect(filterWorkflowEntries(catalog, "DRAFT").valid.map((e) => e.name)).toEqual(["pr-desc"]);
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
    const options = buildPickerOptions([entry], 60);
    expect(options[0]!.name).toBe(`${"Handover".padEnd(47)} ! ${"repo".padStart(7)}`);
    expect(options[0]!.name).not.toContain("inputs");
    expect(options[0]!.name).not.toContain("commands");
    expect(options[0]!.name).not.toContain("transcript");
    expect(options[0]!.name).not.toContain("herdr:pane.close");
    expect(options[0]!.description).toBe("Pick a profile");
  });

  test("humanized title default and provenance badges", () => {
    const { valid } = filterWorkflowEntries(entries, "");
    const options = buildPickerOptions(valid, 60);
    expect(options[0]!.name).toBe(`${"Chat handoff".padEnd(47)} ! ${"repo".padStart(7)}`);
    expect(options[0]!.description).toBe("Pass transcript to a reviewer");
    expect(options[1]!.name).toBe(`${"Deploy".padEnd(47)} ! ${"global".padStart(7)}`);
    expect(options[1]!.description).toBe("deploy");
  });

  test("warning field is bang-space when flagged and two spaces otherwise", () => {
    const warned = formatPickerRowName("Warned", "repo", true, 60);
    const clean = formatPickerRowName("Clean", "repo", false, 60);
    expect(warned.slice(47, 50)).toBe(" ! ");
    expect(clean.slice(47, 50)).toBe("   ");
    expect(warned.endsWith("   repo")).toBe(true);
    expect(clean.endsWith("   repo")).toBe(true);
  });

  test("location is right-aligned in a 7-wide field", () => {
    expect(formatPickerRowName("A", "global", false, 60).slice(-7)).toBe(" global");
    expect(formatPickerRowName("A", "repo", false, 60).slice(-7)).toBe("   repo");
    expect(formatPickerRowName("A", "invalid", false, 60).slice(-7)).toBe("invalid");
  });

  test("unbounded sensitivity flags do not widen the row", () => {
    const flagged: WorkflowListEntry = {
      name: "risky",
      source: "repo",
      file: "/r/risky.yaml",
      title: "Risky",
      hasCommands: true,
      needsTranscript: true,
      sensitiveMethods: ["pane.close", "layout.apply", "agent.send_keys"],
      unresolvedChildren: ["missing-child"],
    };
    const plain: WorkflowListEntry = {
      name: "safe",
      source: "repo",
      file: "/r/safe.yaml",
      title: "Safe",
    };
    const flaggedRow = buildPickerOptions([flagged], 60)[0]!.name;
    const plainRow = buildPickerOptions([plain], 60)[0]!.name;
    expect(flaggedRow.length).toBe(plainRow.length);
    expect(flaggedRow).not.toContain("commands");
    expect(flaggedRow).not.toContain("transcript");
    expect(flaggedRow).not.toContain("herdr:pane.close");
    expect(flaggedRow).not.toContain("herdr:layout.apply");
    expect(flaggedRow).not.toContain("herdr:agent.send_keys");
    expect(flaggedRow).not.toContain("unresolved");
  });

  test("overlong title keeps warning and location columns aligned", () => {
    const short = formatPickerRowName("Short", "repo", true, 60);
    const long = formatPickerRowName("A".repeat(80), "repo", true, 60);
    expect(long.length).toBe(short.length);
    expect(long.slice(-10)).toBe(short.slice(-10));
    expect(long).toContain("…");
  });

  test("inputs are not advertised in the row", () => {
    const withInputs: WorkflowListEntry = {
      name: "ask",
      source: "global",
      file: "/g/ask.yaml",
      title: "Ask",
      inputs: [{ name: "target", type: "text" }],
    };
    const without: WorkflowListEntry = {
      name: "ask",
      source: "global",
      file: "/g/ask.yaml",
      title: "Ask",
    };
    expect(buildPickerOptions([withInputs], 60)[0]!.name).toBe(
      buildPickerOptions([without], 60)[0]!.name,
    );
  });

  test("invalid entries join the option list with stripped errors", () => {
    const { invalid } = filterWorkflowEntries(entries, "");
    const options = buildInvalidOptions(invalid, 60);
    expect(options[0]!.name).toBe(`${"Broken".padEnd(47)}   ${"invalid"}`);
    expect(options[0]!.description).toBe("step 2, agent: unknown agent 'x'");
    expect(options[0]!.description).not.toContain("/r/broken.yaml");
    expect(options[1]!.name).toBe(`${"Chat Broken".padEnd(47)}   ${"invalid"}`);
    expect(options[1]!.description).toBe("cycle");
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

describe("formatListFooter", () => {
  test("hint fits usable width and counter reads index/total", () => {
    const footer = formatListFooter(60, 0, 2);
    expect(footer).toContain(LIST_HINT);
    expect(footer.endsWith("1/2")).toBe(true);
    expect(footer.length).toBe(60);
  });

  test("position counter uses filtered match count", () => {
    expect(formatListFooter(60, 0, 2).endsWith("1/2")).toBe(true);
    expect(formatListFooter(60, 1, 2).endsWith("2/2")).toBe(true);
  });

  test("narrow width still does not exceed content width", () => {
    const footer = formatListFooter(20, 0, 8);
    expect(footer.length).toBeLessThanOrEqual(20);
    expect(footer.endsWith("1/8")).toBe(true);
  });
});

describe("formatDetailLine", () => {
  test("indents by two spaces and truncates to content width", () => {
    expect(formatDetailLine("hello", 60)).toBe("  hello");
    expect(formatDetailLine("hello", 60).startsWith("  ")).toBe(true);
    const long = formatDetailLine("x".repeat(80), 20);
    expect(long.length).toBe(20);
    expect(long.startsWith("  ")).toBe(true);
    expect(long).toContain("…");
  });
});

describe("formatRule", () => {
  test("insets from both sides and derives from content width", () => {
    const rule = formatRule(60);
    expect(rule.startsWith("  ")).toBe(true);
    expect(rule).toBe(`  ${"-".repeat(56)}`);
    expect(rule.length).toBe(58);
    expect(formatRule(10)).toBe(`  ${"-".repeat(6)}`);
  });
});

describe("picker chrome ascii", () => {
  test("filter prompt, short row, rule, and warning marker are ASCII", () => {
    expect(isAscii("/ ")).toBe(true);
    expect(isAscii(formatRule(60))).toBe(true);
    expect(isAscii(formatPickerRowName("Handoff", "global", true, 60))).toBe(true);
    expect(isAscii(formatPickerRowName("Handoff", "repo", false, 60))).toBe(true);
    expect(isAscii("!")).toBe(true);
  });

  test("hints avoid arrow, triangle, and heavy-line glyphs", () => {
    expect(hasAmbiguousChromeGlyph(LIST_HINT)).toBe(false);
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
