import { describe, expect, test } from "bun:test";
import {
  formatFilterUpdateHint,
  LIST_HINT,
  startPickerUpdateCheck,
  UPDATE_INDICATOR,
  updateAvailable,
} from "../../src/picker";
import {
  detailLines,
  formatRunDetailLines,
  runDetailFooter,
  runsFooter,
  SEP,
} from "../../src/runs-browser";
import type { RunDetailBlock } from "../../src/history";

const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);

describe("update indicator", () => {
  test("UPDATE_INDICATOR is printable ASCII containing run hwf update", () => {
    expect(isAscii(UPDATE_INDICATOR)).toBe(true);
    expect(UPDATE_INDICATOR).toContain("run hwf update");
    expect(UPDATE_INDICATOR.startsWith("[")).toBe(true);
    expect(UPDATE_INDICATOR.endsWith("]")).toBe(true);
    expect(isAscii(LIST_HINT)).toBe(true);
    expect(isAscii(SEP)).toBe(true);
    expect(isAscii(runsFooter("current", 0, 3))).toBe(true);
    expect(isAscii(runsFooter("all", 0, 0))).toBe(true);
    expect(isAscii(runDetailFooter())).toBe(true);
    expect(isAscii(runDetailFooter({ allowWorkbench: false }))).toBe(true);
  });

  test("detail lines map the wire ellipsis to ASCII", () => {
    const blocks: RunDetailBlock[] = [
      { kind: "head", status: "FAILED", title: "demo", display_id: "abc12345", elapsed: "1s" },
      { kind: "note", text: "writer heartbeat stale - not a failure" },
      {
        kind: "step",
        depth: 0,
        ordinal: 1,
        total: 2,
        label: "build",
        outcome: "failed",
        explanation: "…tail of a bounded explanation",
      },
    ];
    const mapped = formatRunDetailLines(blocks, 120);
    expect(mapped.every(isAscii)).toBe(true);
    expect(mapped.join("\n")).toContain("...tail of a bounded explanation");

    const lines = detailLines(
      {
        kind: "history-unavailable",
        id: "550e8400-e29b-41d4-a716-446655440000",
        workflow: "demo",
        progress: ["[1/2] build…"],
        message: "…bounded failure",
      },
      120,
    );
    expect(lines.every(isAscii)).toBe(true);
    expect(lines.join("\n")).toContain("[1/2] build...");
    expect(lines.join("\n")).toContain("...bounded failure");
  });

  test("formatFilterUpdateHint hides when width is too narrow", () => {
    expect(formatFilterUpdateHint(10)).toBe("");
    expect(formatFilterUpdateHint(UPDATE_INDICATOR.length + 6)).toBe("");
    expect(formatFilterUpdateHint(UPDATE_INDICATOR.length + 7)).toBe(UPDATE_INDICATOR);
    expect(formatFilterUpdateHint(80)).toBe(UPDATE_INDICATOR);
  });

  test("updateAvailable ignores equal, older, and malformed versions", () => {
    expect(updateAvailable("0.1.0", "0.2.0")).toBe(true);
    expect(updateAvailable("0.2.0", "0.2.0")).toBe(false);
    expect(updateAvailable("0.3.0", "0.2.0")).toBe(false);
    expect(updateAvailable("0.1.0", "not-a-version")).toBe(false);
  });

  test("startPickerUpdateCheck never awaits and ignores failures", async () => {
    const order: string[] = [];
    let resolveCheck!: (v: { version: string } | null) => void;
    const check = () =>
      new Promise<{ version: string } | null>((resolve) => {
        resolveCheck = resolve;
      });

    startPickerUpdateCheck({
      check,
      embeddedVersion: "0.1.0",
      onNewer: (v) => order.push(`newer:${v}`),
    });
    order.push("started");
    expect(order).toEqual(["started"]);

    resolveCheck({ version: "0.2.0" });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["started", "newer:0.2.0"]);

    const failures: string[] = [];
    startPickerUpdateCheck({
      check: async () => {
        throw new Error("network");
      },
      embeddedVersion: "0.1.0",
      onNewer: () => failures.push("should-not-fire"),
    });
    startPickerUpdateCheck({
      check: async () => ({ version: "0.1.0" }),
      embeddedVersion: "0.1.0",
      onNewer: () => failures.push("current"),
    });
    startPickerUpdateCheck({
      check: async () => ({ version: "0.0.9" }),
      embeddedVersion: "0.1.0",
      onNewer: () => failures.push("older"),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
  });
});
