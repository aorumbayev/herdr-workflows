/**
 * Empirical checks against a live herdr 0.7.4 server (skipped when no socket).
 * Confirms layout.apply shapes, agent.list visibility, and pane read text has no ESC.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrCall, herdrRequest, layoutApply, paneRead, tabClose } from "../src/adapter/client";

const socket = process.env.HERDR_SOCKET_PATH ?? "";
const live = Boolean(socket);

describe.skipIf(!live)("herdr 0.7.4 empirical", () => {
  test("layout.apply returns tab+pane ids and pane appears in agent.list", async () => {
    process.env.HERDR_SOCKET_PATH = socket;
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-emp-"));
    const applied = await layoutApply({
      tabLabel: `herdr-workflows-emp-${Date.now().toString(36)}`,
      cwd,
      command: ["sh", "-c", "echo emp; sleep 3"],
      label: "emp",
      focus: false,
    });
    expect(applied.tabId).toMatch(/^w/);
    expect(applied.paneId).toMatch(/^w/);
    const listed = await herdrCall("agent.list", {});
    const panes = ((listed.agents as { pane_id?: string }[]) ?? []).map((a) => a.pane_id);
    expect(panes).toContain(applied.paneId);
    await tabClose(applied.tabId).catch(() => undefined);
  });

  test("pane read --format text has no ESC bytes", async () => {
    process.env.HERDR_SOCKET_PATH = socket;
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-emp-read-"));
    const applied = await layoutApply({
      tabLabel: `herdr-workflows-read-${Date.now().toString(36)}`,
      cwd,
      command: ["sh", "-c", "printf 'hello\\n'; sleep 2"],
      label: "read",
      focus: false,
    });
    await Bun.sleep(200);
    const text = await paneRead(applied.paneId, { source: "recent-unwrapped", lines: 50 });
    expect(text.includes("\u001b")).toBe(false);
    await tabClose(applied.tabId).catch(() => undefined);
  });

  test("plugin.pane.open with tiny popup size does not error on size (clamp)", async () => {
    process.env.HERDR_SOCKET_PATH = socket;
    const response = await herdrRequest("plugin.pane.open", {
      plugin_id: "herdr-workflows",
      entrypoint: "picker",
      placement: "popup",
      width: 1,
      height: 1,
    });
    const code = response.error?.code ?? "";
    expect(code.includes("size")).toBe(false);
  });
});
