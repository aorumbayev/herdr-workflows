/**
 * context: this folder is cut in one dependency order — contract → pane → command → agent-turn →
 * index. Each file may import only files earlier in that list, so no file here may import the
 * orchestrator (`./index`). A back-import is what reverted the earlier attempt at this extraction.
 */
import { join } from "node:path";
import type { InvocationContext, TranscriptExtractor, WorkflowsConfig } from "../context";
import type { ProgressOutcome, RunRecorder } from "../history";
import { isTransportLoss } from "../host";
import type { LoadedWorkflow, TemplateNamespace, WorkflowStep } from "../workflow/grammar";

export type StepFailure = {
  message: string;
  workflow: string;
  action: "agent" | "run" | "herdr" | "workflow";
  step_number: number;
  workflow_path: string[];
  step_id?: string;
  details: Record<string, unknown>;
};

export type StepOutcome =
  | { ok: true; result?: unknown; launched?: boolean; truncated?: boolean }
  | {
      ok: false;
      error: string;
      details?: Record<string, unknown>;
      coordinationLost?: boolean;
      hardFailure?: boolean;
      failure?: StepFailure;
    };

export type RunnerDeps = {
  herdrCall: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notificationShow: (title: string, body?: string) => Promise<void>;
  agentStatus: (target: string) => Promise<string>;
  agentInfo: (target: string) => Promise<Record<string, unknown>>;
  paneClose: (paneId: string) => Promise<void>;
  tabClose: (tabId: string) => Promise<void>;
  reportToken: (paneId: string, value: string | null) => Promise<void>;
  transcriptText: (
    paneId: string,
    transcripts: Record<string, TranscriptExtractor>,
    opts: { invocationCwd: string; projectsBase?: string },
  ) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  responseDir?: string;
};

export type StepRunOpts = {
  name: string;
  repoRoot: string;
  config: WorkflowsConfig;
  ctx: InvocationContext;
  deps: RunnerDeps;
  runId: string;
  workflowPath: string[];
  /** Direct children retained with the current workflow's entry load. */
  children: Map<string, LoadedWorkflow>;
  managedResponseFiles: string[];
  recorder: RunRecorder;
  onProgress?: (step: number, total: number, label: string, outcome?: ProgressOutcome) => void;
  onStderr?: (text: string) => void;
  runSteps: RunSteps;
};

export type StepFrame = {
  step: WorkflowStep;
  stepIndex: number;
  values: TemplateNamespace;
  opts: StepRunOpts;
};

export type StepsResult =
  | { ok: true; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      aborted?: boolean;
      coordinationLost?: boolean;
      failure?: StepFailure;
    };

type RunSteps = (
  steps: WorkflowStep[],
  opts: StepRunOpts,
  values: TemplateNamespace,
) => Promise<StepsResult>;

export class CoordinationError extends Error {
  constructor(action: string, detail: string) {
    super(
      `${action}: herdr coordination was lost (${detail}) — the action may still be active; panes were preserved and on_failure was skipped`,
    );
    this.name = "CoordinationError";
  }
}

export function isCoordinationError(err: unknown): boolean {
  return isTransportLoss(err);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** herdr 0.8.0 read results set `read.truncated` when older scrollback rows were omitted. */
export function readTruncated(result: unknown): boolean {
  const read = (result as { read?: { truncated?: unknown } } | null | undefined)?.read;
  return read?.truncated === true;
}

/** Wrap a dispatched herdr operation so transport loss becomes an uncertain-coordination outcome. */
export function dispatchFailure(action: string, err: unknown): StepOutcome {
  if (isCoordinationError(err)) {
    return {
      ok: false,
      error: new CoordinationError(action, errorText(err)).message,
      coordinationLost: true,
    };
  }
  return { ok: false, error: `${action}: ${errorText(err)}` };
}

/** Repo-local scratch for agent-readable/writable run files (transcripts, prompts, responses). */
export function runScratchDir(repoRoot: string): string {
  return join(repoRoot, ".hwf", "tmp");
}
