import {
  formatRunDetailLines,
  formatRunListEmpty,
  formatRunRow,
  formatStartingDetail,
} from "../history/format";
import { getRunDetail, listRunHistory } from "../history/store";
import { statusLabel } from "../history/project";
import type { RunDetail, RunListItem } from "../history/types";

export type RunsScope = "current" | "all";

/** Shared with picker Select height — six visible rows, scroll for the rest. */
export const RUNS_LIST_VIEWPORT = 6;

/** Production Select height for the runs browser — picker and refresh both call this. */
export function applyRunsListViewport(list: { height: number }): number {
  list.height = RUNS_LIST_VIEWPORT;
  return list.height;
}

/** Cursor index for the selected run id (0 when missing). */
export function runsSelectedIndex(
  items: readonly { id: string }[],
  selectedId: string | undefined,
): number {
  const idx = items.findIndex((item) => item.id === selectedId);
  return Math.max(0, idx);
}

export type RunsBrowserState = {
  scope: RunsScope;
  filter: string;
  items: RunListItem[];
  selectedId?: string;
  hasMachineRuns: boolean;
  unavailable: boolean;
};

export type RunDetailView =
  | { kind: "starting"; id: string; workflow: string }
  | { kind: "local-failure"; id: string; workflow: string; message: string }
  | {
      kind: "history-unavailable";
      id: string;
      workflow: string;
      progress: string[];
      finished?: "succeeded" | "failed";
      message?: string;
    }
  | { kind: "detail"; detail: RunDetail; progress?: string[] };

export async function loadRunsBrowser(
  checkoutRoot: string,
  scope: RunsScope,
  filter: string,
  preserveId?: string,
): Promise<RunsBrowserState> {
  const allProbe = await listRunHistory({ checkout_root: null });
  const hasMachineRuns = allProbe.ok && allProbe.runs.length > 0;
  if (!allProbe.ok) {
    return {
      scope,
      filter,
      items: [],
      hasMachineRuns: false,
      unavailable: true,
    };
  }
  const listed = await listRunHistory({
    checkout_root: scope === "current" ? checkoutRoot : null,
    text: filter,
  });
  if (!listed.ok) {
    return {
      scope,
      filter,
      items: [],
      hasMachineRuns,
      unavailable: true,
    };
  }
  const selectedId =
    preserveId !== undefined && listed.runs.some((r) => r.id === preserveId)
      ? preserveId
      : listed.runs[0]?.id;
  return {
    scope,
    filter,
    items: listed.runs,
    ...(selectedId !== undefined ? { selectedId } : {}),
    hasMachineRuns,
    unavailable: false,
  };
}

export function runsEmptyMessage(state: RunsBrowserState): string {
  if (state.unavailable) return "run history unavailable";
  return formatRunListEmpty({
    scope: state.scope,
    hasMachineRuns: state.hasMachineRuns,
    filterActive: state.filter.trim().length > 0,
  });
}

export function formatRunsOptions(
  items: RunListItem[],
  width: number,
  scope: RunsScope,
): { name: string; description: string; value: { run: RunListItem } }[] {
  return items.map((run) => ({
    name: formatRunRow(run, width, { showLocation: scope === "all" }),
    description: [statusLabel(run.status), run.display_id, run.checkout_root].join(" · "),
    value: { run },
  }));
}

export async function loadRunDetailView(id: string): Promise<RunDetailView> {
  const detail = await getRunDetail(id);
  return { kind: "detail", detail };
}

export function detailLines(view: RunDetailView, width: number): string[] {
  if (view.kind === "starting") return formatStartingDetail(view.workflow, view.id, width);
  if (view.kind === "local-failure") {
    return [
      `LAUNCH FAILED · ${view.workflow} · ${view.id.slice(0, 8)}`.slice(0, width),
      view.message.slice(0, width),
    ];
  }
  if (view.kind === "history-unavailable") {
    const head = view.finished
      ? `${view.finished.toUpperCase()} · HISTORY UNAVAILABLE · ${view.workflow}`
      : `RUNNING · HISTORY UNAVAILABLE · ${view.workflow}`;
    const lines = [head.slice(0, width), ...view.progress.map((line) => line.slice(0, width))];
    if (view.message) lines.push(view.message.slice(0, width));
    return lines;
  }
  const lines = formatRunDetailLines(view.detail, width);
  if (view.progress?.length) {
    return [...lines, "", ...view.progress.map((line) => line.slice(0, width))];
  }
  return lines;
}

export function scrollDetailLines(
  lines: string[],
  scroll: number,
  viewport: number,
): { visible: string[]; scroll: number } {
  const maxScroll = Math.max(0, lines.length - viewport);
  const next = Math.min(Math.max(0, scroll), maxScroll);
  return { visible: lines.slice(next, next + viewport), scroll: next };
}

export function runsFooter(scope: RunsScope, index: number, total: number): string {
  const scopeLabel = scope === "current" ? "Current" : "All";
  const pos = total === 0 ? "0/0" : `${index + 1}/${total}`;
  return `tab workflows · ctrl+g ${scopeLabel} · enter detail · esc quit · ${pos}`;
}

export function runDetailFooter(opts: { allowWorkbench?: boolean } = {}): string {
  const allow = opts.allowWorkbench !== false;
  return allow ? "w workbench · esc back · up/down scroll" : "esc back · up/down scroll";
}
