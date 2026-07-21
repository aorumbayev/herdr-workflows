import { sanitizeDisplay } from "../adapter/stdin";
import { runWorkflow } from "../runner";
import type { WorkflowListEntry } from "../workflows";
import {
  finish,
  setConfirmMode,
  setInputMode,
  setPromptMode,
  setRunMode,
  type PickerState,
} from "./picker-modes";
import { formatRunProgress } from "./picker-rows";
import { truncate } from "./text";

const FAIL_HINT = "enter/esc close";

function showFailure(state: PickerState, entry: WorkflowListEntry, error: unknown): void {
  state.running = false;
  state.status.content = formatRunProgress(entry.name, state.progressLines, {
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
  state.footer.content = FAIL_HINT;
}

/** Declared inputs first, then {prompt} if used, then run. */
function advanceInput(state: PickerState, entry: WorkflowListEntry): void {
  const spec = state.inputQueue[state.inputIndex];
  if (spec) return setInputMode(state, entry, spec);
  if (entry.needsPrompt) return setPromptMode(state, entry);
  void startRun(state, entry, "");
}

function storeInput(state: PickerState, value: string): void {
  const entry = state.pending;
  const spec = state.inputQueue[state.inputIndex];
  if (!entry || !spec) return;
  state.inputValues[spec.name] = value;
  state.inputIndex += 1;
  advanceInput(state, entry);
}

export function submitInputChoice(state: PickerState, value: string): void {
  if (state.mode === "input") storeInput(state, value);
}

export function submitInputText(state: PickerState, value: string): void {
  if (state.mode === "input") storeInput(state, value.trim());
}

export function acceptWorkflow(state: PickerState, entry: WorkflowListEntry): void {
  state.pending = entry;
  if ((entry.repoOwned ?? entry.source === "repo") || entry.dynamicOptions) {
    setConfirmMode(state, entry);
    return;
  }
  void prepareWorkflow(state, entry, false);
}

export async function prepareWorkflow(
  state: PickerState,
  entry: WorkflowListEntry,
  confirmed = true,
): Promise<void> {
  // Lock input while dynamic choices resolve so one confirmation starts one command.
  setRunMode(state, entry);
  try {
    const workflow =
      state.workflow ??
      (await state.loadWorkflow(entry, state.repoRoot, Object.keys(state.agents)));
    entry.needsPrompt = workflow.needsPrompt;
    entry.inputs = workflow.inputs;
    entry.repoOwned = workflow.repoOwned;
    state.pending = entry;
    state.workflow = workflow;
    if (workflow.repoOwned && !confirmed) {
      state.running = false;
      setConfirmMode(state, entry);
      return;
    }
    state.inputQueue = entry.inputs ?? [];
    state.inputIndex = 0;
    state.inputValues = {};
    state.running = false;
    advanceInput(state, entry);
  } catch (error) {
    showFailure(state, entry, error);
  }
}

export function submitPrompt(state: PickerState, value: string): void {
  if (state.mode === "prompt" && state.pending) {
    void startRun(state, state.pending, value.trim());
  }
}

export async function startRun(
  state: PickerState,
  entry: WorkflowListEntry,
  prompt: string,
): Promise<void> {
  const inputs = Object.fromEntries(
    Object.entries(state.inputValues).map(([key, value]) => [key, sanitizeDisplay(value)]),
  );
  setRunMode(state, entry);
  try {
    const workflow =
      state.workflow ??
      (await state.loadWorkflow(entry, state.repoRoot, Object.keys(state.agents)));
    const result = await runWorkflow({
      name: entry.name,
      repoRoot: state.repoRoot,
      agents: state.agents,
      sessions: state.sessions,
      ctx: state.ctx,
      prompt: sanitizeDisplay(prompt),
      inputs,
      workflow,
      onProgress: (step, total, label) => {
        state.progressLines.push(`[${step}/${total}] ${truncate(label, 48)}`);
        state.status.content = formatRunProgress(entry.name, state.progressLines);
      },
    });
    state.running = false;
    state.status.content = formatRunProgress(entry.name, state.progressLines, {
      ok: result.ok,
      detail: result.ok ? "" : result.error,
    });
    if (result.ok) {
      finish(state, 0);
      return;
    }
    state.footer.content = FAIL_HINT;
  } catch (error) {
    showFailure(state, entry, error);
  }
}
