import { formatHistoryAck } from "./ack";
import { RunHistorySession } from "./store";
import type {
  RunActionKind,
  RunFailureFact,
  RunStepOutcomeKind,
  RunStepPhase,
  RunTerminalStatus,
} from "./types";
import type { LoadedWorkflow, WorkflowStep } from "../workflow/types";

type RunFinalStatus = RunTerminalStatus;

/** Narrow outcome shape the recorder persists — avoids importing the engine context module. */
type RecorderOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
      details?: Record<string, unknown>;
      coordinationLost?: boolean;
    };

export type RunRecorder = {
  readonly runId: string;
  child(scope: { name: string; workflowPath: string[]; parentOrdinal?: number }): RunRecorder;
  stepStarted(
    step: WorkflowStep,
    ordinal: number,
    total: number,
    label: string,
    phase?: RunStepPhase,
  ): Promise<void>;
  stepFinished(
    step: WorkflowStep,
    ordinal: number,
    total: number,
    label: string,
    kind: RunStepOutcomeKind,
    outcome?: RecorderOutcome,
    phase?: RunStepPhase,
  ): Promise<void>;
  finished(status: RunFinalStatus, extras?: { returns?: unknown; error?: string }): Promise<void>;
  dispose(): void;
};

type RecorderScope = {
  name: string;
  workflowPath: string[];
  parentOrdinal?: number;
};

type SharedState = {
  finalized: boolean;
};

function failureFact(
  step: WorkflowStep,
  outcome: Extract<RecorderOutcome, { ok: false }>,
): RunFailureFact {
  const details = outcome.details ?? {};
  return {
    action: step.action.kind as RunActionKind,
    ...(typeof details.exit_code === "number" ? { exit_code: details.exit_code } : {}),
    ...(step.action.kind === "herdr" ? { method: step.action.method } : {}),
    ...(outcome.coordinationLost === true ? { coordination: "lost" } : {}),
    ...(step.id ? { step_id: step.id } : {}),
  };
}

function stepBase(
  scope: RecorderScope,
  step: WorkflowStep,
  ordinal: number,
  total: number,
  label: string,
  phase: RunStepPhase,
) {
  return {
    phase,
    workflow: scope.name,
    workflow_path: [...scope.workflowPath],
    ordinal,
    total,
    ...(scope.parentOrdinal !== undefined ? { parent_ordinal: scope.parentOrdinal } : {}),
    ...(step.id ? { step_id: step.id } : {}),
    action: step.action.kind as RunActionKind,
    label,
  };
}

function emitAck(onAck: ((line: string) => void) | undefined, line: string): void {
  try {
    onAck?.(line);
  } catch {
    /* observed channel best-effort */
  }
}

function makeRecorder(
  session: RunHistorySession | undefined,
  runId: string,
  scope: RecorderScope,
  state: SharedState,
): RunRecorder {
  return {
    runId,
    child(next) {
      return makeRecorder(session, runId, next, state);
    },
    async stepStarted(step, ordinal, total, label, phase = "main") {
      if (!session) return;
      await session.setCurrentStep({
        ...stepBase(scope, step, ordinal, total, label, phase),
        started_at: new Date().toISOString(),
      });
    },
    async stepFinished(step, ordinal, total, label, kind, outcome, phase = "main") {
      if (!session) return;
      const failed = outcome !== undefined && !outcome.ok;
      // Nested child steps already carry the explanation; wrapper records facts only.
      const explainFailure = failed && step.action.kind !== "workflow";
      await session.recordStep({
        ...stepBase(scope, step, ordinal, total, label, phase),
        finished_at: new Date().toISOString(),
        outcome: kind,
        ...(failed
          ? {
              failure: failureFact(step, outcome),
              ...(explainFailure ? { explanation: outcome.error } : {}),
            }
          : {}),
      });
    },
    async finished(status, extras) {
      if (state.finalized) return;
      state.finalized = true;
      if (!session) return;
      await session.finalize(status, extras ?? {}).catch(() => undefined);
    },
    dispose() {
      session?.dispose();
    },
  };
}

export async function createRunRecorder(opts: {
  workflow: LoadedWorkflow;
  runId?: string;
  checkoutRoot: string;
  onAck?: (line: string) => void;
}): Promise<{ ok: false; error: string } | { ok: true; recorder: RunRecorder }> {
  const session = new RunHistorySession();
  const claim = await session.claim({
    ...(opts.runId !== undefined ? { id: opts.runId } : {}),
    workflow: opts.workflow.name,
    ...(opts.workflow.title !== undefined ? { title: opts.workflow.title } : {}),
    source: opts.workflow.repoOwned ? "repo" : "global",
    checkout_root: opts.checkoutRoot,
  });
  const scope: RecorderScope = {
    name: opts.workflow.name,
    workflowPath: [opts.workflow.name],
  };
  if (!claim.ok) {
    emitAck(
      opts.onAck,
      formatHistoryAck({
        state: "rejected",
        error: claim.error,
        ...(claim.id !== undefined ? { id: claim.id } : {}),
      }),
    );
    session.dispose();
    return { ok: false, error: claim.error };
  }
  if (claim.state === "unavailable") {
    emitAck(opts.onAck, formatHistoryAck({ state: "unavailable", id: claim.id }));
    session.dispose();
    return { ok: true, recorder: makeRecorder(undefined, claim.id, scope, { finalized: false }) };
  }
  emitAck(opts.onAck, formatHistoryAck({ state: "claimed", id: claim.id }));
  return {
    ok: true,
    recorder: makeRecorder(session, claim.id, scope, { finalized: false }),
  };
}
