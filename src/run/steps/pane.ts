import { HerdrError } from "../../herdr";
import type { PaneOpen } from "../../workflow/types";
import { sizeToFirstRatio, type RunnerDeps } from "../context";

export type PlacedPane = { pane_id: string; tab_id: string; workspace_id: string };

type PlaceAnchors = { paneId?: string; tabId?: string; workspaceId?: string };

export type PlaceOpts = {
  open: PaneOpen;
  target?: string;
  workspace?: string;
  size?: number;
  focus: boolean;
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
  deps: { herdrCall: RunnerDeps["herdrCall"] };
  invocation: PlaceAnchors;
};

type PaneInfoish = { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown };

function fail(detail: string): never {
  throw new HerdrError("placement_failed", detail);
}

function requireWorkspace(o: PlaceOpts): string {
  const workspace = o.workspace ?? o.invocation.workspaceId;
  if (!workspace) fail("pane.open: tab needs pane.workspace or an invocation workspace");
  return workspace;
}

function requireTargetPane(o: PlaceOpts): string {
  const target = o.target ?? o.invocation.paneId;
  if (!target) fail(`pane.open: ${o.open} needs pane.target or an invocation pane`);
  return target;
}

function splitDirection(open: PaneOpen): "right" | "down" {
  return open === "beside" ? "right" : "down";
}

function placedFrom(source: unknown, where: string): PlacedPane {
  const info = (source ?? {}) as PaneInfoish;
  const paneId = info.pane_id;
  const tabId = info.tab_id;
  const workspaceId = info.workspace_id;
  if (typeof paneId !== "string" || typeof tabId !== "string" || typeof workspaceId !== "string") {
    fail(`${where} did not return pane/tab/workspace identifiers`);
  }
  return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

/** Empty shell pane for a managed agent: tab.create for tabs, pane.split for beside/below. */
export async function placeEmptyPane(o: PlaceOpts): Promise<PlacedPane> {
  if (o.open === "tab") {
    const result = await o.deps.herdrCall("tab.create", {
      workspace_id: requireWorkspace(o),
      cwd: o.cwd ?? null,
      env: o.env ?? {},
      focus: o.focus,
      label: o.label ?? null,
    });
    const tab = (result.tab ?? {}) as PaneInfoish;
    const pane = placedFrom(result.root_pane, "tab.create");
    return {
      pane_id: pane.pane_id,
      tab_id: typeof tab.tab_id === "string" ? tab.tab_id : pane.tab_id,
      workspace_id: typeof tab.workspace_id === "string" ? tab.workspace_id : pane.workspace_id,
    };
  }
  const result = await o.deps.herdrCall("pane.split", {
    direction: splitDirection(o.open),
    target_pane_id: requireTargetPane(o),
    ratio: o.size !== undefined ? sizeToFirstRatio(o.size) : null,
    cwd: o.cwd ?? null,
    env: o.env ?? {},
    focus: o.focus,
  });
  return placedFrom(result.pane, "pane.split");
}

type LayoutNodeish = {
  pane_id?: unknown;
  second?: LayoutNodeish;
};

type LayoutResult = {
  tab_id?: unknown;
  workspace_id?: unknown;
  focused_pane_id?: unknown;
  root?: LayoutNodeish;
};

function createdPaneId(layout: LayoutResult, split: boolean): string {
  const node = split ? layout.root?.second : layout.root;
  const fromTree = node?.pane_id;
  if (typeof fromTree === "string") return fromTree;
  if (typeof layout.focused_pane_id === "string") return layout.focused_pane_id;
  return fail("layout.apply did not return the created pane id");
}

function layoutPlacement(result: Record<string, unknown>, split: boolean): PlacedPane {
  const layout = (result.layout ?? {}) as LayoutResult;
  const tabId = layout.tab_id;
  const workspaceId = layout.workspace_id;
  if (typeof tabId !== "string" || typeof workspaceId !== "string") {
    fail("layout.apply did not return tab/workspace identifiers");
  }
  return { pane_id: createdPaneId(layout, split), tab_id: tabId, workspace_id: workspaceId };
}

async function tabOfPane(o: PlaceOpts, paneId: string): Promise<string> {
  if (paneId === o.invocation.paneId && o.invocation.tabId) return o.invocation.tabId;
  const result = await o.deps.herdrCall("pane.get", { pane_id: paneId });
  const pane = (result.pane ?? {}) as PaneInfoish;
  if (typeof pane.tab_id !== "string") fail(`pane.get did not return a tab for ${paneId}`);
  return pane.tab_id;
}

/** Pane running a command: only layout.apply can attach argv to a created pane. */
export async function placeCommandPane(o: PlaceOpts & { argv: string[] }): Promise<PlacedPane> {
  const leaf = {
    type: "pane",
    label: o.label ?? null,
    cwd: o.cwd ?? null,
    command: o.argv,
    env: o.env ?? {},
  };
  if (o.open === "tab") {
    const result = await o.deps.herdrCall("layout.apply", {
      workspace_id: requireWorkspace(o),
      tab_label: o.label ?? null,
      tab_id: null,
      focus: o.focus,
      root: leaf,
    });
    return layoutPlacement(result, false);
  }
  const target = requireTargetPane(o);
  const result = await o.deps.herdrCall("layout.apply", {
    workspace_id: null,
    tab_id: await tabOfPane(o, target),
    tab_label: null,
    focus: o.focus,
    root: {
      type: "split",
      direction: splitDirection(o.open),
      ratio: o.size !== undefined ? sizeToFirstRatio(o.size) : 0.5,
      first: { type: "pane", pane_id: target },
      second: leaf,
    },
  });
  return layoutPlacement(result, true);
}
