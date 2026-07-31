import { basename } from "node:path";
import { statusLabel } from "./project";
import type { RunDetail, RunListItem, RunProjectedStatus } from "./types";

const SEP = " · ";

function truncateGraphemes(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max === 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? `${sec % 60}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? `${min % 60}m` : ""}`;
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
    loc = truncateGraphemes(loc, locBudget);
    remain -= loc ? loc.length + SEP.length : 0;
  } else {
    loc = "";
  }
  workflow = truncateGraphemes(workflow, remain);
  return [status, workflow, progress, elapsed, loc].filter(Boolean).join(SEP);
}

export function formatRunListEmpty(opts: {
  scope: "current" | "all";
  hasMachineRuns: boolean;
  filterActive: boolean;
}): string {
  if (opts.filterActive) return "no matching runs";
  if (!opts.hasMachineRuns) return "no workflow has run yet";
  if (opts.scope === "current") return `no runs in this worktree${SEP}Ctrl+G for All`;
  return "no runs";
}

export function formatRunDetailLines(detail: RunDetail, width: number): string[] {
  if (detail.kind === "invalid") return [truncateGraphemes(detail.message ?? "invalid run", width)];
  if (detail.kind === "missing")
    return [truncateGraphemes(detail.message ?? "run not found", width)];
  if (detail.kind === "expired") return [truncateGraphemes(detail.message ?? "run expired", width)];
  if (detail.kind === "unavailable") {
    return [truncateGraphemes(detail.message ?? "history unavailable", width)];
  }
  const lines: string[] = [];
  const head = [
    statusLabel(detail.status),
    detail.title || detail.workflow,
    detail.display_id,
    formatElapsed(detail.elapsed_ms),
  ]
    .filter(Boolean)
    .join(SEP);
  lines.push(truncateGraphemes(head, width));
  lines.push(truncateGraphemes(detail.checkout_root, width));
  if (detail.status === "stale") {
    lines.push(truncateGraphemes("writer heartbeat stale — not a failure", width));
  }
  for (const step of detail.steps) {
    const indent = Math.max(0, step.workflow_path.length - 1);
    const prefix = `${"  ".repeat(indent)}${step.ordinal}/${step.total} `;
    const outcome = step.outcome ?? (step.active ? "running" : "");
    const body = `${prefix}${step.label}${outcome ? `${SEP}${outcome}` : ""}`;
    lines.push(truncateGraphemes(body, width));
    if (step.explanation) {
      lines.push(truncateGraphemes(`${"  ".repeat(indent + 1)}${step.explanation}`, width));
    }
  }
  if (detail.current_step?.active) {
    const step = detail.current_step;
    const indent = Math.max(0, step.workflow_path.length - 1);
    lines.push(
      truncateGraphemes(
        `${"  ".repeat(indent)}${step.ordinal}/${step.total} ${step.label}${SEP}running`,
        width,
      ),
    );
  }
  if (detail.remaining !== undefined && detail.remaining > 0) {
    lines.push(
      truncateGraphemes(
        `${detail.remaining} step${detail.remaining === 1 ? "" : "s"} not run`,
        width,
      ),
    );
  }
  if (detail.failure_explanation && !detail.steps.some((s) => s.explanation)) {
    lines.push(truncateGraphemes(detail.failure_explanation, width));
  }
  return lines.length > 0 ? lines : [truncateGraphemes("no step outcomes yet", width)];
}

export function formatStartingDetail(workflow: string, id: string, width: number): string[] {
  return [
    truncateGraphemes(`STARTING${SEP}${workflow}${SEP}${id.slice(0, 8)}`, width),
    truncateGraphemes("claiming run history…", width),
  ];
}
