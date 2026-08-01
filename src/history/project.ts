import {
  RUN_HISTORY_LIST_LIMIT,
  RUN_HISTORY_STALE_MS,
  RUN_UUID_RE,
  type RunDetail,
  type RunDetailStep,
  type RunFailureFact,
  type RunListFilter,
  type RunListItem,
  type RunProjectedStatus,
  type RunSnapshot,
  type RunStepRecord,
  type RunWorkflowSource,
} from "./types";

export function normalizeRunUuid(raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  return RUN_UUID_RE.test(id) ? id : undefined;
}

function displayRunId(id: string): string {
  return id.slice(0, 8);
}

/** History-internal projection — surfaces use `listRuns` / `runDetail`. */
export function projectStatus(snapshot: RunSnapshot, now: number = Date.now()): RunProjectedStatus {
  if (snapshot.status === "succeeded") return "succeeded";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.status === "interrupted") return "interrupted";
  const age = now - Date.parse(snapshot.heartbeat_at);
  if (!Number.isFinite(age) || age >= RUN_HISTORY_STALE_MS) return "stale";
  return "running";
}

function failureFactOf(steps: RunStepRecord[]): RunFailureFact | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (
      step.outcome === "failed" ||
      step.outcome === "failed_continued" ||
      step.outcome === "interrupted"
    ) {
      return step.failure;
    }
  }
  return undefined;
}

function progressOf(snapshot: RunSnapshot): { done: number; total: number } | undefined {
  const entry = snapshot.steps.filter(
    (s) => s.workflow === snapshot.workflow && s.phase === "main",
  );
  const totals = entry.map((s) => s.total);
  const total =
    snapshot.current_step?.workflow === snapshot.workflow
      ? snapshot.current_step.total
      : totals.length > 0
        ? Math.max(...totals)
        : undefined;
  if (total === undefined) return undefined;
  return { done: entry.length, total };
}

function elapsedMs(snapshot: RunSnapshot, status: RunProjectedStatus, now: number): number {
  const started = Date.parse(snapshot.started_at);
  const end =
    snapshot.finished_at !== undefined
      ? Date.parse(snapshot.finished_at)
      : status === "running" || status === "stale"
        ? now
        : started;
  return Math.max(0, end - started);
}

function identityFields(snapshot: RunSnapshot, status: RunProjectedStatus, now: number) {
  return {
    id: snapshot.id,
    display_id: displayRunId(snapshot.id),
    workflow: snapshot.workflow,
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
    source: snapshot.source,
    checkout_root: snapshot.checkout_root,
    status,
    started_at: snapshot.started_at,
    ...(snapshot.finished_at !== undefined ? { finished_at: snapshot.finished_at } : {}),
    elapsed_ms: elapsedMs(snapshot, status, now),
  };
}

/** History-internal projection — surfaces use `listRuns`. */
export function toListItem(snapshot: RunSnapshot, now: number = Date.now()): RunListItem {
  const status = projectStatus(snapshot, now);
  const progress = progressOf(snapshot);
  const failure = failureFactOf(snapshot.steps);
  const step_labels = [
    ...snapshot.steps.map((s) => s.label),
    ...(snapshot.current_step !== undefined ? [snapshot.current_step.label] : []),
  ];
  return {
    ...identityFields(snapshot, status, now),
    ...(progress !== undefined ? { progress } : {}),
    ...(snapshot.current_step !== undefined ? { current_label: snapshot.current_step.label } : {}),
    ...(step_labels.length > 0 ? { step_labels } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

function remainingCount(snapshot: RunSnapshot): number | undefined {
  if (snapshot.status === undefined) return undefined;
  if (snapshot.status === "succeeded") return undefined;
  const entryMain = snapshot.steps.filter(
    (s) => s.workflow === snapshot.workflow && s.phase === "main",
  );
  if (entryMain.length === 0) return undefined;
  const total = Math.max(...entryMain.map((s) => s.total));
  const remaining = total - entryMain.length;
  return remaining > 0 ? remaining : undefined;
}

function detailStepFromRecord(step: RunStepRecord): RunDetailStep {
  return { ...step };
}

function detailStepFromCurrent(step: NonNullable<RunSnapshot["current_step"]>): RunDetailStep {
  return { ...step, active: true };
}

function isNestedUnder(parentPath: string[], childPath: string[]): boolean {
  if (childPath.length <= parentPath.length) return false;
  return parentPath.every((part, i) => childPath[i] === part);
}

function belongsToWrapper(parent: RunDetailStep, child: RunDetailStep): boolean {
  if (child.phase === "recovery") return false;
  if (child.parent_ordinal === undefined) return false;
  if (child.parent_ordinal !== parent.ordinal) return false;
  return isNestedUnder(parent.workflow_path, child.workflow_path);
}

/** Parent workflow wrapper before nested children even when children were recorded first. */
function orderDetailSteps(steps: RunDetailStep[]): RunDetailStep[] {
  if (steps.length <= 1) return steps;
  const out: RunDetailStep[] = [];
  const used = new Set<number>();

  const emit = (index: number): void => {
    if (used.has(index)) return;
    used.add(index);
    const parent = steps[index]!;
    out.push(parent);
    // Ordinary preceding steps share the entry path — only workflow: wrappers own descendants.
    if (parent.action !== "workflow") return;
    const children = steps
      .map((step, i) => ({ step, i }))
      .filter(({ step, i }) => !used.has(i) && belongsToWrapper(parent, step))
      .sort((a, b) => {
        const depthDelta = a.step.workflow_path.length - b.step.workflow_path.length;
        if (depthDelta !== 0) return depthDelta;
        if (a.step.ordinal !== b.step.ordinal) return a.step.ordinal - b.step.ordinal;
        return a.i - b.i;
      });
    for (const child of children) {
      if (child.step.workflow_path.length === parent.workflow_path.length + 1) emit(child.i);
    }
    for (const child of children) emit(child.i);
  };

  const topLen = Math.min(...steps.map((s) => s.workflow_path.length));
  const tops = steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => step.workflow_path.length === topLen)
    .sort((a, b) => {
      if (a.step.ordinal !== b.step.ordinal) return a.step.ordinal - b.step.ordinal;
      return a.i - b.i;
    });
  for (const top of tops) emit(top.i);
  for (let i = 0; i < steps.length; i++) emit(i);
  return out;
}

/** History-internal projection — surfaces use `runDetail`. */
export function toDetail(snapshot: RunSnapshot, opts: { now?: number } = {}): RunDetail {
  const now = opts.now ?? Date.now();
  const status = projectStatus(snapshot, now);
  const steps = orderDetailSteps(snapshot.steps.map(detailStepFromRecord));
  const current =
    snapshot.current_step !== undefined ? detailStepFromCurrent(snapshot.current_step) : undefined;
  let failure_explanation: string | undefined;
  for (let i = snapshot.steps.length - 1; i >= 0; i--) {
    const step = snapshot.steps[i]!;
    if (step.explanation) {
      failure_explanation = step.explanation;
      break;
    }
  }
  const remaining = remainingCount(snapshot);
  return {
    kind: "snapshot",
    ...identityFields(snapshot, status, now),
    heartbeat_at: snapshot.heartbeat_at,
    ...(current !== undefined ? { current_step: current } : {}),
    steps,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(failure_explanation !== undefined ? { failure_explanation } : {}),
  };
}

function searchableText(item: RunListItem): string {
  const parts = [
    item.workflow,
    item.title ?? "",
    item.id,
    item.display_id,
    item.status,
    item.current_label ?? "",
    ...(item.step_labels ?? []),
    item.source,
    item.checkout_root,
    item.failure?.action ?? "",
    item.failure?.method ?? "",
    item.failure?.step_id ?? "",
    item.failure?.exit_code !== undefined ? String(item.failure.exit_code) : "",
    item.failure?.coordination ?? "",
  ];
  return parts.join("\n").toLowerCase();
}

function matchesListFilter(item: RunListItem, filter: RunListFilter): boolean {
  if (filter.checkout_root !== undefined) {
    if (filter.checkout_root === null) {
      /* All — no root predicate */
    } else if (item.checkout_root !== filter.checkout_root) {
      return false;
    }
  }
  if (filter.status !== undefined) {
    const want = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!want.includes(item.status)) return false;
  }
  const text = filter.text?.trim().toLowerCase();
  if (text && !searchableText(item).includes(text)) return false;
  return true;
}

function sortNewestFirst(items: RunListItem[]): RunListItem[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(a.started_at);
    const bt = Date.parse(b.started_at);
    if (bt !== at) return bt - at;
    return b.id.localeCompare(a.id);
  });
}

/** History-internal list filter — surfaces use `listRuns`. */
export function filterSortLimit(items: RunListItem[], filter: RunListFilter = {}): RunListItem[] {
  const matched = items.filter((item) => matchesListFilter(item, filter));
  return sortNewestFirst(matched).slice(0, RUN_HISTORY_LIST_LIMIT);
}

export function statusLabel(status: RunProjectedStatus): string {
  if (status === "running") return "RUNNING";
  if (status === "stale") return "STALE";
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "failed") return "FAILED";
  if (status === "interrupted") return "INTERRUPTED";
  return "STARTING";
}

export type RunDetailBlock =
  | { kind: "head"; status: string; title: string; display_id: string; elapsed: string }
  | { kind: "note"; text: string }
  | {
      kind: "step";
      depth: number;
      ordinal: number;
      total: number;
      label: string;
      outcome: string;
      explanation?: string;
    }
  | { kind: "error"; text: string };

export function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? `${sec % 60}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? `${min % 60}m` : ""}`;
}

/** Synthetic snapshot for the picker between history claim and the first poll. */
export function optimisticRunningDetail(opts: {
  id: string;
  workflow: string;
  source: RunWorkflowSource;
  checkout_root: string;
}): Extract<RunDetail, { kind: "snapshot" }> {
  const now = new Date().toISOString();
  return {
    kind: "snapshot",
    id: opts.id,
    display_id: opts.id.slice(0, 8),
    workflow: opts.workflow,
    source: opts.source,
    checkout_root: opts.checkout_root,
    status: "running",
    started_at: now,
    heartbeat_at: now,
    elapsed_ms: 0,
    steps: [],
  };
}

/** History-internal presentation — surfaces consume `runDetail().blocks`. */
export function presentRunDetail(detail: RunDetail): RunDetailBlock[] {
  if (detail.kind === "invalid") {
    return [{ kind: "error", text: detail.message ?? "invalid run" }];
  }
  if (detail.kind === "missing") {
    return [{ kind: "error", text: detail.message ?? "run not found" }];
  }
  if (detail.kind === "expired") {
    return [{ kind: "error", text: detail.message ?? "run expired" }];
  }
  if (detail.kind === "unavailable") {
    return [{ kind: "error", text: detail.message ?? "history unavailable" }];
  }

  const blocks: RunDetailBlock[] = [];
  blocks.push({
    kind: "head",
    status: statusLabel(detail.status),
    title: detail.title || detail.workflow,
    display_id: detail.display_id,
    elapsed: formatElapsed(detail.elapsed_ms),
  });
  blocks.push({ kind: "note", text: detail.checkout_root });
  if (detail.status === "stale") {
    blocks.push({ kind: "note", text: "writer heartbeat stale — not a failure" });
  }
  const hasSteps = detail.steps.length > 0 || Boolean(detail.current_step?.active);
  const hasRemaining = detail.remaining !== undefined && detail.remaining > 0;
  const hasFailure =
    Boolean(detail.failure_explanation) && !detail.steps.some((s) => s.explanation);
  for (const step of detail.steps) {
    const depth = Math.max(0, step.workflow_path.length - 1);
    const outcome = step.outcome ?? (step.active ? "running" : "");
    blocks.push({
      kind: "step",
      depth,
      ordinal: step.ordinal,
      total: step.total,
      label: step.label,
      outcome,
      ...(step.explanation !== undefined ? { explanation: step.explanation } : {}),
    });
  }
  if (detail.current_step?.active) {
    const step = detail.current_step;
    blocks.push({
      kind: "step",
      depth: Math.max(0, step.workflow_path.length - 1),
      ordinal: step.ordinal,
      total: step.total,
      label: step.label,
      outcome: "running",
    });
  }
  if (hasRemaining) {
    blocks.push({
      kind: "note",
      text: `${detail.remaining} step${detail.remaining === 1 ? "" : "s"} not run`,
    });
  }
  if (hasFailure && detail.failure_explanation) {
    blocks.push({ kind: "error", text: detail.failure_explanation });
  }
  if (!hasSteps && !hasRemaining && !hasFailure) {
    blocks.push({ kind: "note", text: "no step outcomes yet" });
  }
  return blocks;
}
