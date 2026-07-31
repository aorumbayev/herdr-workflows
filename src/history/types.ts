/** Versioned private run snapshot and allowlisted projections. */

import { z } from "zod";

export const RUN_HISTORY_VERSION = 1 as const;
export const RUN_HISTORY_HEARTBEAT_MS = 5_000;
export const RUN_HISTORY_STALE_MS = 15_000;
export const RUN_HISTORY_RETENTION_BYTES = 512_000;
export const RUN_HISTORY_LIST_LIMIT = 40;

export const RUN_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const RUN_UUID_RE = new RegExp(`^${RUN_UUID_PATTERN}$`);

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

const isoTimestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)));

const failureFactSchema = z.object({
  action: z.enum(["agent", "run", "herdr", "workflow"]),
  exit_code: z.number().optional(),
  method: z.string().optional(),
  coordination: z.string().optional(),
  step_id: z.string().optional(),
});

const stepIdentitySchema = z
  .object({
    phase: z.enum(["main", "recovery"]),
    workflow: z.string().min(1),
    workflow_path: z.array(z.string()),
    ordinal: z.number().int().min(1),
    total: z.number().int().min(1),
    parent_ordinal: z.number().int().min(1).optional(),
    step_id: z.string().optional(),
    action: z.enum(["agent", "run", "herdr", "workflow"]),
    label: z.string(),
  })
  .refine((row) => row.ordinal <= row.total, { message: "ordinal exceeds total" })
  .superRefine((row, ctx) => {
    const nested = row.workflow_path.length > 1;
    if (nested && row.parent_ordinal === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "nested step requires parent_ordinal",
        path: ["parent_ordinal"],
      });
    }
    if (!nested && row.parent_ordinal !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "top-level step must omit parent_ordinal",
        path: ["parent_ordinal"],
      });
    }
  });

const runStepRecordSchema = stepIdentitySchema.and(
  z.object({
    started_at: isoTimestamp.optional(),
    finished_at: isoTimestamp,
    outcome: z.enum([
      "succeeded",
      "skipped",
      "launched",
      "failed_continued",
      "failed",
      "interrupted",
    ]),
    failure: failureFactSchema.optional(),
    explanation: z.string().optional(),
  }),
);

const runCurrentStepSchema = stepIdentitySchema.and(
  z.object({
    started_at: isoTimestamp,
  }),
);

const runSnapshotSchema = z
  .object({
    version: z.literal(RUN_HISTORY_VERSION),
    id: z.string().refine((id) => RUN_UUID_RE.test(id.trim().toLowerCase())),
    workflow: z.string().min(1),
    title: z.string().optional(),
    source: z.enum(["repo", "global"]),
    checkout_root: z.string().min(1),
    started_at: isoTimestamp,
    heartbeat_at: isoTimestamp,
    finished_at: isoTimestamp.optional(),
    current_step: runCurrentStepSchema.optional(),
    steps: z.array(runStepRecordSchema),
    status: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    returns: z.unknown().optional(),
  })
  .superRefine((row, ctx) => {
    const hasStatus = row.status !== undefined;
    const hasFinished = row.finished_at !== undefined;
    if (hasStatus) {
      if (!hasFinished) {
        ctx.addIssue({
          code: "custom",
          message: "terminal status requires finished_at",
          path: ["finished_at"],
        });
      }
      if (row.current_step !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "terminal status forbids current_step",
          path: ["current_step"],
        });
      }
    } else if (hasFinished) {
      ctx.addIssue({
        code: "custom",
        message: "finished_at requires status",
        path: ["status"],
      });
    }
  });

export type RunFailureFact = z.infer<typeof failureFactSchema>;
export type RunStepRecord = z.infer<typeof runStepRecordSchema>;
export type RunCurrentStep = z.infer<typeof runCurrentStepSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

/** Structural guard for on-disk snapshots — reject before projection. */
export function isSnapshot(value: unknown): value is RunSnapshot {
  return runSnapshotSchema.safeParse(value).success;
}

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

export type RunDetailStep = Omit<RunStepRecord, "finished_at" | "outcome"> & {
  finished_at?: string;
  outcome?: RunStepOutcomeKind;
  active?: boolean;
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
  | { ok: true; state: "unavailable"; id: string }
  | { ok: false; state: "rejected"; error: string; id?: string };
