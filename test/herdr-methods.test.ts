import { describe, expect, test } from "bun:test";
import {
  checkHerdrProtocol,
  HERDR_PROTOCOL,
  isMethodResultDotPath,
  isResultDotPath,
  METHOD_RESULT_VARIANTS,
  MIN_HERDR_VERSION,
  RESULT_DOT_PATHS,
  validateMethodParams,
} from "../src/herdr-methods";

describe("herdr method validators", () => {
  test("rejects unknown param key", () => {
    expect(validateMethodParams("worktree.create", { brnach: "main" })).toMatch(
      /unknown param 'brnach'/,
    );
  });

  test("rejects wrong param type", () => {
    expect(validateMethodParams("pane.split", { direction: "right", ratio: "wide" })).toMatch(
      /param 'ratio' expects/,
    );
  });

  test("rejects missing required param", () => {
    expect(validateMethodParams("pane.split", {})).toMatch(/missing required param 'direction'/);
  });

  test("denied method returns its reason", () => {
    expect(validateMethodParams("server.stop", {})).toMatch(
      /would stop the server running the workflow/,
    );
    expect(validateMethodParams("plugin.disable", { plugin_id: "herdr-workflows" })).toMatch(
      /plugin lifecycle methods/,
    );
  });

  test("allowed method with valid params passes", () => {
    expect(validateMethodParams("notification.show", { title: "done" })).toBeUndefined();
    expect(
      validateMethodParams("pane.split", { direction: "right", ratio: 0.333 }),
    ).toBeUndefined();
  });

  test("protocol mismatch surfaces version error", () => {
    const bad = checkHerdrProtocol(HERDR_PROTOCOL + 1);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.error).toContain(`connected=${HERDR_PROTOCOL + 1}`);
    expect(bad.error).toContain(`pinned=${HERDR_PROTOCOL}`);
    expect(bad.error).toContain(MIN_HERDR_VERSION);
  });

  test("matching protocol passes", () => {
    expect(checkHerdrProtocol(HERDR_PROTOCOL)).toEqual({ ok: true, protocol: HERDR_PROTOCOL });
  });

  test("result dot-paths include known pane fields", () => {
    expect(RESULT_DOT_PATHS.size).toBeGreaterThan(0);
    expect(isResultDotPath("pane.pane_id")).toBe(true);
    expect(isResultDotPath("pane.pane_ids")).toBe(false);
  });

  test("per-method result paths stay method-scoped", () => {
    expect(HERDR_PROTOCOL).toBe(17);
    expect(MIN_HERDR_VERSION).toBe("0.7.5");
    const notify = METHOD_RESULT_VARIANTS.get("notification.show");
    expect(notify?.map((v) => v.type)).toEqual(["notification_show"]);
    expect(isMethodResultDotPath("notification.show", "shown")).toBe(true);
    expect(isMethodResultDotPath("notification.show", "worktree.path")).toBe(false);
    expect(isMethodResultDotPath("worktree.create", "worktree.path")).toBe(true);
    expect(isMethodResultDotPath("pane.wait_for_output", "matched_line")).toBe(true);
    expect(isMethodResultDotPath("pane.wait_for_output", "read.text")).toBe(true);
  });
});
