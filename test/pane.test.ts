import { describe, expect, test } from "bun:test";
import { placeCommandPane, quoteArgvForShell } from "../src/run/steps/pane";

describe("placeCommandPane", () => {
  test("beside splits then send_input and never layout.apply", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const placed = await placeCommandPane({
      open: "beside",
      target: "w1:pM",
      focus: false,
      argv: ["sh", "-c", "echo LISTENING; sleep 20"],
      deps: {
        herdrCall: async (method, params = {}) => {
          calls.push({ method, params });
          if (method === "pane.split") {
            return {
              pane: { pane_id: "w1:pNew", tab_id: "w1:t1", workspace_id: "w1" },
            };
          }
          return { type: "ok" };
        },
      },
      invocation: { paneId: "w1:pM", tabId: "w1:t1", workspaceId: "w1" },
    });
    expect(placed.pane_id).toBe("w1:pNew");
    expect(calls.map((c) => c.method)).toEqual(["pane.split", "pane.send_input"]);
    expect(calls[0]?.params).toMatchObject({
      direction: "right",
      target_pane_id: "w1:pM",
    });
    expect(calls[1]?.params).toMatchObject({
      pane_id: "w1:pNew",
      keys: ["Enter"],
    });
    expect(String(calls[1]?.params.text)).toContain("LISTENING");
    expect(calls.some((c) => c.method === "layout.apply")).toBe(false);
  });

  test("below uses down split then send_input", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    await placeCommandPane({
      open: "below",
      focus: true,
      argv: ["printf", "hi"],
      deps: {
        herdrCall: async (method, params = {}) => {
          calls.push({ method, params });
          if (method === "pane.split") {
            return {
              pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" },
            };
          }
          return { type: "ok" };
        },
      },
      invocation: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    });
    expect(calls[0]?.params).toMatchObject({ direction: "down", target_pane_id: "w1:p1" });
    expect(calls.map((c) => c.method)).toEqual(["pane.split", "pane.send_input"]);
  });

  test("tab still uses layout.apply with argv command leaf", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const placed = await placeCommandPane({
      open: "tab",
      focus: true,
      argv: ["sh", "-c", "echo hi"],
      deps: {
        herdrCall: async (method, params = {}) => {
          calls.push({ method, params });
          return {
            layout: {
              tab_id: "w1:t2",
              workspace_id: "w1",
              focused_pane_id: "w1:pTab",
              root: { type: "pane", pane_id: "w1:pTab" },
            },
          };
        },
      },
      invocation: { workspaceId: "w1" },
    });
    expect(placed.pane_id).toBe("w1:pTab");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("layout.apply");
    expect(calls[0]?.params.root).toMatchObject({
      type: "pane",
      command: ["sh", "-c", "echo hi"],
    });
  });

  test("quoteArgvForShell preserves simple tokens and quotes spaces", () => {
    expect(quoteArgvForShell(["echo", "hi"], "darwin")).toBe("echo hi");
    expect(quoteArgvForShell(["sh", "-c", "echo LISTENING; sleep 1"], "darwin")).toBe(
      "sh -c 'echo LISTENING; sleep 1'",
    );
  });
});
