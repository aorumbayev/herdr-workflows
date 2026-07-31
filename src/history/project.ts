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
} from "./types";

export function normalizeRunUuid(raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  return RUN_UUID_RE.test(id) ? id : undefined;
}

function displayRunId(id: string): string {
  return id.slice(0, 8);
}

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
  return {
    phase: step.phase,
    workflow: step.workflow,
    workflow_path: step.workflow_path,
    ordinal: step.ordinal,
    total: step.total,
    ...(step.parent_ordinal !== undefined ? { parent_ordinal: step.parent_ordinal } : {}),
    ...(step.step_id !== undefined ? { step_id: step.step_id } : {}),
    action: step.action,
    label: step.label,
    ...(step.started_at !== undefined ? { started_at: step.started_at } : {}),
    finished_at: step.finished_at,
    outcome: step.outcome,
    ...(step.failure !== undefined ? { failure: step.failure } : {}),
    ...(step.explanation !== undefined ? { explanation: step.explanation } : {}),
  };
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

export function toDetail(
  snapshot: RunSnapshot,
  opts: {
    now?: number;
    openWorkflow?: { name: string; source: "repo" | "global" };
  } = {},
): RunDetail {
  const now = opts.now ?? Date.now();
  const status = projectStatus(snapshot, now);
  const steps = orderDetailSteps(snapshot.steps.map(detailStepFromRecord));
  const current =
    snapshot.current_step !== undefined
      ? ({
          phase: snapshot.current_step.phase,
          workflow: snapshot.current_step.workflow,
          workflow_path: snapshot.current_step.workflow_path,
          ordinal: snapshot.current_step.ordinal,
          total: snapshot.current_step.total,
          ...(snapshot.current_step.parent_ordinal !== undefined
            ? { parent_ordinal: snapshot.current_step.parent_ordinal }
            : {}),
          ...(snapshot.current_step.step_id !== undefined
            ? { step_id: snapshot.current_step.step_id }
            : {}),
          action: snapshot.current_step.action,
          label: snapshot.current_step.label,
          started_at: snapshot.current_step.started_at,
          active: true,
        } satisfies RunDetailStep)
      : undefined;
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
    ...(opts.openWorkflow !== undefined ? { open_workflow: opts.openWorkflow } : {}),
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
