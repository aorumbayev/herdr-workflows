import { basename } from "node:path";
import {
  formatElapsed,
  listRuns,
  statusLabel,
  type RunDetail,
  type RunDetailBlock,
  type RunListItem,
  type RunProjectedStatus,
} from "../history";
import { truncate } from "./picker-rows";

const SEP = " · ";

export type RunsScope = "current" | "all";

/** Shared list/detail summary: status · display id · checkout root. */
export function formatRunSummary(run: {
  status: RunProjectedStatus;
  display_id: string;
  checkout_root: string;
}): string {
  return [statusLabel(run.status), run.display_id, run.checkout_root].join(SEP);
}

export function formatRunListEmpty(opts: {
  scope: "current" | "all";
  hasMachineRuns: boolean;
  filterActive: boolean;
  unavailable?: boolean;
}): string {
  if (opts.unavailable) return "run history unavailable";
  if (opts.filterActive) return "no matching runs";
  if (!opts.hasMachineRuns) return "no workflow has run yet";
  if (opts.scope === "current") return `no runs in this worktree${SEP}Ctrl+G for All`;
  return "no runs";
}

export function formatRunsOptions(
  items: RunListItem[],
  width: number,
  scope: RunsScope,
): { name: string; description: string; value: { run: RunListItem } }[] {
  return items.map((run) => ({
    name: formatRunRow(run, width, { showLocation: scope === "all" }),
    description: formatRunSummary(run),
    value: { run },
  }));
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

function abbreviateStatus(status: RunProjectedStatus, width: number): string {
  const full = statusLabel(status);
  if (full.length <= width) return full;
  if (status === "interrupted") return width >= 5 ? "INTR" : "I";
  if (status === "succeeded") return width >= 4 ? "OK" : "O";
  if (status === "failed") return width >= 4 ? "FAIL" : "F";
  if (status === "running") return width >= 3 ? "RUN" : "R";
  if (status === "stale") return width >= 3 ? "STL" : "S";
  return width >= 3 ? "…" : "";
}

/** One list row; priority: status, progress, elapsed, workflow, optional location. */
export function formatRunRow(
  item: RunListItem,
  width: number,
  opts: { showLocation?: boolean } = {},
): string {
  const status = abbreviateStatus(item.status, Math.min(12, Math.max(3, width)));
  const progress =
    item.progress !== undefined ? `${item.progress.done}/${item.progress.total}` : "";
  const elapsed = formatElapsed(item.elapsed_ms);
  const location = opts.showLocation ? basename(item.checkout_root) : "";
  const fixed = [status, progress, elapsed].filter(Boolean);
  const fixedWidth = fixed.reduce((n, part) => n + part.length + SEP.length, 0);
  let remain = Math.max(0, width - fixedWidth);
  let workflow = item.title || item.workflow;
  let loc = location;
  if (loc && remain > 0) {
    const locBudget = Math.min(loc.length, Math.max(0, Math.floor(remain / 3)));
    loc = truncate(loc, locBudget);
    remain -= loc ? loc.length + SEP.length : 0;
  } else {
    loc = "";
  }
  workflow = truncate(workflow, remain);
  return [status, workflow, progress, elapsed, loc].filter(Boolean).join(SEP);
}

function blockToLines(block: RunDetailBlock, width: number): string[] {
  if (block.kind === "head") {
    const head = [block.status, block.title, block.display_id, block.elapsed]
      .filter(Boolean)
      .join(SEP);
    return [truncate(head, width)];
  }
  if (block.kind === "note" || block.kind === "error") {
    return [truncate(block.text, width)];
  }
  const indent = "  ".repeat(block.depth);
  const outcome = block.outcome ? `${SEP}${block.outcome}` : "";
  const lines = [
    truncate(`${indent}${block.ordinal}/${block.total} ${block.label}${outcome}`, width),
  ];
  if (block.explanation) {
    lines.push(truncate(`${indent}  ${block.explanation}`, width));
  }
  return lines;
}

export function formatRunDetailLines(blocks: RunDetailBlock[], width: number): string[] {
  return blocks.flatMap((block) => blockToLines(block, width));
}

function formatStartingDetail(workflow: string, id: string, width: number): string[] {
  return [
    truncate(`STARTING${SEP}${workflow}${SEP}${id.slice(0, 8)}`, width),
    truncate("claiming run history…", width),
  ];
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
  | { kind: "detail"; detail: RunDetail; blocks: RunDetailBlock[]; progress?: string[] };

export function viewAllowsWorkbench(view: RunDetailView): boolean {
  return (
    view.kind !== "history-unavailable" && view.kind !== "local-failure" && view.kind !== "starting"
  );
}

export async function loadRunsBrowser(
  checkoutRoot: string,
  scope: RunsScope,
  filter: string,
  preserveId?: string,
): Promise<RunsBrowserState> {
  const allProbe = await listRuns({ checkout_root: null });
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
  const listed = await listRuns({
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
  const lines = formatRunDetailLines(view.blocks, width);
  if (view.progress?.length) {
    return [...lines, "", ...view.progress.map((line) => line.slice(0, width))];
  }
  return lines;
}
