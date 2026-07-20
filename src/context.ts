import { paneRead } from "./adapter/client";
import { sanitizeDisplay } from "./adapter/stdin";
import { PANE_READ_LINES, PANE_READ_SOURCE } from "./pane-read";
import type { PlaceholderValues } from "./workflows";

export type InvocationContext = {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  selection: string;
  cwd: string;
};

type CtxJson = {
  workspace_id?: string;
  tab_id?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  pane_id?: string;
  selected_text?: string;
  cwd?: string;
  worktree?: { path?: string };
  workspace?: { workspace_id?: string; cwd?: string };
  tab?: { tab_id?: string };
  pane?: { pane_id?: string };
};

export function readInvocationContext(): InvocationContext {
  let json: CtxJson = {};
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      json = JSON.parse(raw) as CtxJson;
    } catch {
      json = {};
    }
  }
  return {
    workspaceId:
      process.env.HERDR_WORKSPACE_ID || json.workspace_id || json.workspace?.workspace_id,
    tabId: process.env.HERDR_TAB_ID || json.tab_id || json.tab?.tab_id,
    paneId: process.env.HERDR_PANE_ID || json.focused_pane_id || json.pane_id || json.pane?.pane_id,
    selection: json.selected_text ?? "",
    cwd:
      json.worktree?.path ||
      json.focused_pane_cwd ||
      json.cwd ||
      json.workspace?.cwd ||
      process.cwd(),
  };
}

export async function buildPlaceholders(opts: {
  ctx: InvocationContext;
  prompt?: string;
  last?: string;
  error?: string;
  session?: string;
  agent?: string;
  inputs?: Record<string, string>;
}): Promise<PlaceholderValues> {
  let pane = "";
  if (opts.ctx.paneId) {
    const scrollback = await paneRead(opts.ctx.paneId, {
      source: PANE_READ_SOURCE,
      lines: PANE_READ_LINES,
    }).catch(() => "");
    pane = sanitizeDisplay(scrollback);
  }
  return {
    pane,
    selection: sanitizeDisplay(opts.ctx.selection),
    prompt: opts.prompt ?? "",
    last: opts.last ?? "",
    error: opts.error ?? "",
    session: opts.session ?? "",
    tab: "",
    prev_tab: "",
    agent: opts.agent ?? "",
    inputs: opts.inputs ?? {},
  };
}
