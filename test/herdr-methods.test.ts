import { describe, expect, test } from "bun:test";
import manifest from "../herdr-plugin.toml";
import {
  checkHerdrStartup,
  HERDR_PROTOCOL,
  isMethodResultDotPath,
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
    expect(validateMethodParams("agent.view.set", { source: "x" })).toMatch(/agent view filters/);
  });

  test("allowed method with valid params passes", () => {
    expect(validateMethodParams("notification.show", { title: "done" })).toBeUndefined();
    expect(
      validateMethodParams("pane.split", { direction: "right", ratio: 0.333 }),
    ).toBeUndefined();
  });

  test("whole-value templates skip enum and type checks", () => {
    expect(
      validateMethodParams("pane.split", {
        direction: "{{inputs.d}}",
        target_pane_id: "w1:p1",
      }),
    ).toBeUndefined();
    expect(
      validateMethodParams("pane.zoom", { mode: "{{inputs.z}}", pane_id: "w1:p1" }),
    ).toBeUndefined();
    expect(
      validateMethodParams("pane.split", {
        direction: "sideways",
        target_pane_id: "w1:p1",
      }),
    ).toMatch(/param 'direction' must be one of/);
  });

  test("protocol mismatch names installed/required versions and both protocols", () => {
    const bad = checkHerdrStartup({ protocol: HERDR_PROTOCOL + 1, version: MIN_HERDR_VERSION });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.error).toContain(`connected=${HERDR_PROTOCOL + 1}`);
    expect(bad.error).toContain(`pinned=${HERDR_PROTOCOL}`);
    expect(bad.error).toContain(`installed=${MIN_HERDR_VERSION}`);
    expect(bad.error).toContain(`required≥${MIN_HERDR_VERSION}`);
  });

  test("version below manifest minimum is rejected", () => {
    const bad = checkHerdrStartup({ protocol: HERDR_PROTOCOL, version: "0.7.4" });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.error).toContain("herdr version too old");
    expect(bad.error).toContain("installed=0.7.4");
    expect(bad.error).toContain(`required≥${MIN_HERDR_VERSION}`);
    expect(bad.error).toContain(`connected=${HERDR_PROTOCOL}`);
    expect(bad.error).toContain(`pinned=${HERDR_PROTOCOL}`);
  });

  test("matching version and protocol pass", () => {
    expect(checkHerdrStartup({ protocol: HERDR_PROTOCOL, version: MIN_HERDR_VERSION })).toEqual({
      ok: true,
      protocol: HERDR_PROTOCOL,
      version: MIN_HERDR_VERSION,
    });
    expect(checkHerdrStartup({ protocol: HERDR_PROTOCOL, version: "0.8.0" })).toMatchObject({
      ok: true,
    });
  });

  test("result dot-paths include known pane fields", () => {
    expect(RESULT_DOT_PATHS.size).toBeGreaterThan(0);
    expect(RESULT_DOT_PATHS.has("pane.pane_id")).toBe(true);
    expect(RESULT_DOT_PATHS.has("pane.pane_ids")).toBe(false);
  });

  test("per-method result paths stay method-scoped", () => {
    expect(HERDR_PROTOCOL).toBe(17);
    expect(MIN_HERDR_VERSION).toBe(manifest.min_herdr_version);
    const notify = METHOD_RESULT_VARIANTS.get("notification.show");
    expect(notify?.map((v) => v.type)).toEqual(["notification_show"]);
    expect(isMethodResultDotPath("notification.show", "shown")).toBe(true);
    expect(isMethodResultDotPath("notification.show", "worktree.path")).toBe(false);
    expect(isMethodResultDotPath("worktree.create", "worktree.path")).toBe(true);
    expect(isMethodResultDotPath("pane.wait_for_output", "matched_line")).toBe(true);
    expect(isMethodResultDotPath("pane.wait_for_output", "read.text")).toBe(true);
  });
});
