import {
  RUN_HISTORY_VERSION,
  RUN_UUID_RE,
  type RunActionKind,
  type RunCurrentStep,
  type RunFailureFact,
  type RunSnapshot,
  type RunStepOutcomeKind,
  type RunStepPhase,
  type RunStepRecord,
  type RunTerminalStatus,
} from "./types";

const PHASES = new Set<RunStepPhase>(["main", "recovery"]);
const ACTIONS = new Set<RunActionKind>(["agent", "run", "herdr", "workflow"]);
const OUTCOMES = new Set<RunStepOutcomeKind>([
  "succeeded",
  "skipped",
  "launched",
  "failed_continued",
  "failed",
  "interrupted",
]);
const TERMINAL = new Set<RunTerminalStatus>(["succeeded", "failed", "interrupted"]);

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isFailureFact(value: unknown): value is RunFailureFact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.action !== "string" || !ACTIONS.has(row.action as RunActionKind)) return false;
  if (row.exit_code !== undefined && typeof row.exit_code !== "number") return false;
  if (row.method !== undefined && typeof row.method !== "string") return false;
  if (row.coordination !== undefined && typeof row.coordination !== "string") return false;
  if (row.step_id !== undefined && typeof row.step_id !== "string") return false;
  return true;
}

function stepIdentityFields(row: Record<string, unknown>): boolean {
  if (typeof row.phase !== "string" || !PHASES.has(row.phase as RunStepPhase)) return false;
  if (typeof row.workflow !== "string" || !row.workflow) return false;
  if (!Array.isArray(row.workflow_path) || !row.workflow_path.every((p) => typeof p === "string")) {
    return false;
  }
  if (!isPositiveInt(row.ordinal) || !isPositiveInt(row.total)) return false;
  if (row.ordinal > row.total) return false;
  if (typeof row.action !== "string" || !ACTIONS.has(row.action as RunActionKind)) return false;
  if (typeof row.label !== "string") return false;
  if (row.step_id !== undefined && typeof row.step_id !== "string") return false;
  return true;
}

/** Nested paths (below entry) require parent_ordinal; top-level must omit it. */
function parentOrdinalMatchesNesting(row: Record<string, unknown>): boolean {
  if (!Array.isArray(row.workflow_path)) return false;
  const nested = row.workflow_path.length > 1;
  if (nested) return isPositiveInt(row.parent_ordinal);
  return row.parent_ordinal === undefined;
}

function isStepRecord(value: unknown): value is RunStepRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!stepIdentityFields(row)) return false;
  if (row.started_at !== undefined && !isIsoTimestamp(row.started_at)) return false;
  if (!isIsoTimestamp(row.finished_at)) return false;
  if (typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome as RunStepOutcomeKind)) {
    return false;
  }
  if (row.failure !== undefined && !isFailureFact(row.failure)) return false;
  if (row.explanation !== undefined && typeof row.explanation !== "string") return false;
  return true;
}

function isCurrentStep(value: unknown): value is RunCurrentStep {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!stepIdentityFields(row)) return false;
  return isIsoTimestamp(row.started_at);
}

/** Structural guard for on-disk snapshots — reject before projection. */
export function isSnapshot(value: unknown): value is RunSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== RUN_HISTORY_VERSION) return false;
  if (typeof row.id !== "string" || !RUN_UUID_RE.test(row.id.trim().toLowerCase())) return false;
  if (typeof row.workflow !== "string" || !row.workflow) return false;
  if (row.title !== undefined && typeof row.title !== "string") return false;
  if (row.source !== "repo" && row.source !== "global") return false;
  if (typeof row.checkout_root !== "string" || !row.checkout_root) return false;
  if (!isIsoTimestamp(row.started_at) || !isIsoTimestamp(row.heartbeat_at)) return false;
  if (row.finished_at !== undefined && !isIsoTimestamp(row.finished_at)) return false;

  const hasStatus = row.status !== undefined;
  const hasFinished = row.finished_at !== undefined;
  if (hasStatus) {
    if (typeof row.status !== "string" || !TERMINAL.has(row.status as RunTerminalStatus)) {
      return false;
    }
    if (!hasFinished) return false;
    if (row.current_step !== undefined) return false;
  } else if (hasFinished) {
    return false;
  }

  if (row.current_step !== undefined) {
    if (!isCurrentStep(row.current_step)) return false;
    if (!parentOrdinalMatchesNesting(row.current_step as Record<string, unknown>)) return false;
  }
  if (!Array.isArray(row.steps) || !row.steps.every(isStepRecord)) return false;
  for (const step of row.steps) {
    if (!parentOrdinalMatchesNesting(step as Record<string, unknown>)) return false;
  }
  return true;
}
