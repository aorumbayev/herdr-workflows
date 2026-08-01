import { describe, expect, test } from "bun:test";
import {
  formatFilterUpdateHint,
  startPickerUpdateCheck,
  UPDATE_INDICATOR,
  updateAvailable,
} from "../../src/tui/update-indicator";

const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);

describe("update indicator", () => {
  test("UPDATE_INDICATOR is printable ASCII containing run hwf update", () => {
    expect(isAscii(UPDATE_INDICATOR)).toBe(true);
    expect(UPDATE_INDICATOR).toContain("run hwf update");
    expect(UPDATE_INDICATOR.startsWith("[")).toBe(true);
    expect(UPDATE_INDICATOR.endsWith("]")).toBe(true);
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
