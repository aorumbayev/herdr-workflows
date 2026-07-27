/**
 * Empirical checks against a live herdr 0.7.5 server (skipped when no socket).
 * Confirms layout.apply shapes, agent.list visibility, and pane read text has no ESC.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrCall, herdrRequest, tabClose } from "../src/herdr";

const socket = process.env.HERDR_SOCKET_PATH ?? "";
const live = Boolean(socket);

type AppliedLayout = { tabId: string; paneId: string };

async function applyCommandTab(
  label: string,
  cwd: string,
  command: string[],
): Promise<AppliedLayout> {
  const result = await herdrCall("layout.apply", {
    workspace_id: null,
    tab_label: label,
    tab_id: null,
    focus: false,
    root: { type: "pane", label, cwd, command, env: {} },
  });
  const layout = result.layout as {
    tab_id?: string;
    focused_pane_id?: string;
    root?: { pane_id?: string };
  };
  expect(typeof layout.tab_id).toBe("string");
  return {
    tabId: layout.tab_id ?? "",
    paneId: layout.root?.pane_id ?? layout.focused_pane_id ?? "",
  };
}

describe.skipIf(!live)("herdr 0.7.5 empirical", () => {
  test("layout.apply returns tab+pane ids and pane appears in agent.list", async () => {
    process.env.HERDR_SOCKET_PATH = socket;
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-emp-"));
    const applied = await applyCommandTab(`herdr-workflows-emp-${Date.now().toString(36)}`, cwd, [
      "sh",
      "-c",
      "echo emp; sleep 3",
    ]);
    expect(applied.tabId).toMatch(/^w/);
    expect(applied.paneId).toMatch(/^w/);
    const listed = await herdrCall("agent.list", {});
    const panes = ((listed.agents as { pane_id?: string }[]) ?? []).map((a) => a.pane_id);
    expect(panes).toContain(applied.paneId);
    await tabClose(applied.tabId).catch(() => undefined);
  });

  test("pane.read text format has no ESC bytes", async () => {
    process.env.HERDR_SOCKET_PATH = socket;
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-emp-read-"));
    const applied = await applyCommandTab(`herdr-workflows-read-${Date.now().toString(36)}`, cwd, [
      "sh",
      "-c",
      "printf 'hello\\n'; sleep 2",
    ]);
    await Bun.sleep(200);
    const result = await herdrCall("pane.read", {
      pane_id: applied.paneId,
      source: "recent_unwrapped",
      format: "text",
      lines: 50,
    });
    const read = result.read as { text?: string };
    expect((read.text ?? "").includes("\u001b")).toBe(false);
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
