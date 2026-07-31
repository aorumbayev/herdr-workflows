/** Versioned private run snapshot and allowlisted projections. */

export const RUN_HISTORY_VERSION = 1 as const;
export const RUN_HISTORY_HEARTBEAT_MS = 5_000;
export const RUN_HISTORY_STALE_MS = 15_000;
export const RUN_HISTORY_RETENTION_BYTES = 512_000;
export const RUN_HISTORY_LIST_LIMIT = 40;

export const RUN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunWorkflowSource = "repo" | "global";
export type RunStepPhase = "main" | "recovery";
export type RunActionKind = "agent" | "run" | "herdr" | "workflow";
export type RunStepOutcomeKind =
  | "succeeded"
  | "skipped"
  | "launched"
  | "failed_continued"
  | "failed"
  | "interrupted";

export type RunTerminalStatus = "succeeded" | "failed" | "interrupted";
export type RunProjectedStatus =
  | "running"
  | "stale"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "starting";

export type RunFailureFact = {
  action: RunActionKind;
  exit_code?: number;
  method?: string;
  coordination?: string;
  step_id?: string;
};

export type RunStepRecord = {
  phase: RunStepPhase;
  workflow: string;
  workflow_path: string[];
  ordinal: number;
  total: number;
  /** Invoking workflow: step ordinal at the parent path — disambiguates sequential wrappers. */
  parent_ordinal?: number;
  step_id?: string;
  action: RunActionKind;
  label: string;
  started_at?: string;
  finished_at: string;
  outcome: RunStepOutcomeKind;
  failure?: RunFailureFact;
  explanation?: string;
};

export type RunCurrentStep = {
  phase: RunStepPhase;
  workflow: string;
  workflow_path: string[];
  ordinal: number;
  total: number;
  parent_ordinal?: number;
  step_id?: string;
  action: RunActionKind;
  label: string;
  started_at: string;
};

export type RunSnapshot = {
  version: typeof RUN_HISTORY_VERSION;
  id: string;
  workflow: string;
  title?: string;
  source: RunWorkflowSource;
  checkout_root: string;
  started_at: string;
  heartbeat_at: string;
  finished_at?: string;
  current_step?: RunCurrentStep;
  steps: RunStepRecord[];
  status?: RunTerminalStatus;
  returns?: unknown;
};

export type RunListItem = {
  id: string;
  display_id: string;
  workflow: string;
  title?: string;
  source: RunWorkflowSource;
  checkout_root: string;
  status: RunProjectedStatus;
  started_at: string;
  finished_at?: string;
  elapsed_ms: number;
  progress?: { done: number; total: number };
  current_label?: string;
  /** Safe completed/active step labels for search — never explanations. */
  step_labels?: string[];
  failure?: RunFailureFact;
};

export type RunDetailStep = {
  phase: RunStepPhase;
  workflow: string;
  workflow_path: string[];
  ordinal: number;
  total: number;
  parent_ordinal?: number;
  step_id?: string;
  action: RunActionKind;
  label: string;
  started_at?: string;
  finished_at?: string;
  outcome?: RunStepOutcomeKind;
  active?: boolean;
  failure?: RunFailureFact;
  explanation?: string;
};

export type RunDetail =
  | {
      kind: "snapshot";
      id: string;
      display_id: string;
      workflow: string;
      title?: string;
      source: RunWorkflowSource;
      checkout_root: string;
      status: RunProjectedStatus;
      started_at: string;
      finished_at?: string;
      heartbeat_at: string;
      elapsed_ms: number;
      current_step?: RunDetailStep;
      steps: RunDetailStep[];
      remaining?: number;
      failure_explanation?: string;
      open_workflow?: { name: string; source: RunWorkflowSource };
    }
  | { kind: "missing"; id: string; message: string }
  | { kind: "expired"; id: string; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; id?: string; message: string };

export type RunListFilter = {
  checkout_root?: string | null;
  text?: string;
  status?: RunProjectedStatus | RunProjectedStatus[];
  now?: number;
};

export type HistoryClaimResult =
  | { ok: true; state: "claimed"; id: string }
  | { ok: true; state: "unavailable"; id?: string }
  | { ok: false; state: "rejected"; error: string; id?: string };
