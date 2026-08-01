import type { RunStepOutcomeKind, RunStepPhase, RunTerminalStatus } from "../src/history/types";
import type { StepOutcome } from "../src/run/context";
import type { RunRecorder } from "../src/history/recorder";
import type { WorkflowStep } from "../src/workflow/types";

export type FakeRecorderCall =
  | {
      kind: "stepStarted";
      scope: { name: string; workflowPath: string[]; parentOrdinal?: number };
      step: WorkflowStep;
      ordinal: number;
      total: number;
      label: string;
      phase: RunStepPhase;
    }
  | {
      kind: "stepFinished";
      scope: { name: string; workflowPath: string[]; parentOrdinal?: number };
      step: WorkflowStep;
      ordinal: number;
      total: number;
      label: string;
      outcomeKind: RunStepOutcomeKind;
      outcome?: StepOutcome;
      phase: RunStepPhase;
    }
  | {
      kind: "finished";
      status: RunTerminalStatus;
      extras?: { returns?: unknown; error?: string };
    }
  | { kind: "dispose" };

export type FakeRunRecorder = RunRecorder & {
  calls: FakeRecorderCall[];
  finishedCalls: Extract<FakeRecorderCall, { kind: "finished" }>[];
  stepFinishedCalls: Extract<FakeRecorderCall, { kind: "stepFinished" }>[];
};

const DEFAULT_RUN_ID = "00000000-0000-4000-8000-000000000001";

export function fakeRunRecorder(
  runId = DEFAULT_RUN_ID,
  scope: { name: string; workflowPath: string[]; parentOrdinal?: number } = {
    name: "m",
    workflowPath: ["m"],
  },
  shared: { calls: FakeRecorderCall[]; finalized: boolean } = {
    calls: [],
    finalized: false,
  },
): FakeRunRecorder {
  const recorder: FakeRunRecorder = {
    runId,
    get calls() {
      return shared.calls;
    },
    get finishedCalls() {
      return shared.calls.filter(
        (c): c is Extract<FakeRecorderCall, { kind: "finished" }> => c.kind === "finished",
      );
    },
    get stepFinishedCalls() {
      return shared.calls.filter(
        (c): c is Extract<FakeRecorderCall, { kind: "stepFinished" }> => c.kind === "stepFinished",
      );
    },
    child(next) {
      return fakeRunRecorder(runId, next, shared);
    },
    async stepStarted(step, ordinal, total, label, phase = "main") {
      shared.calls.push({
        kind: "stepStarted",
        scope: { ...scope, workflowPath: [...scope.workflowPath] },
        step,
        ordinal,
        total,
        label,
        phase,
      });
    },
    async stepFinished(step, ordinal, total, label, outcomeKind, outcome, phase = "main") {
      shared.calls.push({
        kind: "stepFinished",
        scope: { ...scope, workflowPath: [...scope.workflowPath] },
        step,
        ordinal,
        total,
        label,
        outcomeKind,
        ...(outcome !== undefined ? { outcome } : {}),
        phase,
      });
    },
    async finished(status, extras) {
      if (shared.finalized) return;
      shared.finalized = true;
      shared.calls.push({
        kind: "finished",
        status,
        ...(extras !== undefined ? { extras } : {}),
      });
    },
    dispose() {
      shared.calls.push({ kind: "dispose" });
    },
  };
  return recorder;
}
