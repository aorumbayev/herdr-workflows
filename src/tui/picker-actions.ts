import type { KeyEvent } from "@opentui/core";
import { sanitizeDisplay } from "../adapter/stdin";
import { runWorkflow } from "../runner";
import type { WorkflowListEntry } from "../workflows";
import {
  finish,
  setConfirmMode,
  setInputMode,
  setListMode,
  setPromptMode,
  setRunMode,
  type PickerState,
} from "./picker-modes";
import { formatRunProgress } from "./picker-rows";
import { truncate } from "./text";

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
  if (state.mode !== "input") return;
  storeInput(state, value);
}

export function submitInputText(state: PickerState, value: string): void {
  if (state.mode !== "input") return;
  storeInput(state, value.trim());
}

const FAIL_HINT = "enter/esc close";

export function acceptWorkflow(state: PickerState, entry: WorkflowListEntry): void {
  state.pending = entry;
  if (entry.source === "repo") {
    setConfirmMode(state, entry);
    return;
  }
  state.inputQueue = entry.inputs ?? [];
  state.inputIndex = 0;
  state.inputValues = {};
  advanceInput(state, entry);
}

export function submitPrompt(state: PickerState, value: string): void {
  if (state.mode !== "prompt" || !state.pending) return;
  void startRun(state, state.pending, value.trim());
}

async function startRun(
  state: PickerState,
  entry: WorkflowListEntry,
  prompt: string,
): Promise<void> {
  const inputs = Object.fromEntries(
    Object.entries(state.inputValues).map(([k, v]) => [k, sanitizeDisplay(v)]),
  );
  setRunMode(state, entry);
  const result = await runWorkflow({
    name: entry.name,
    repoRoot: state.repoRoot,
    agents: state.agents,
    sessions: state.sessions,
    ctx: state.ctx,
    prompt: sanitizeDisplay(prompt),
    inputs,
    onProgress: (i, n, label) => {
      state.progressLines.push(`[${i}/${n}] ${truncate(label, 48)}`);
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
}

function navigateSelectList(state: PickerState, key: KeyEvent): boolean {
  if (key.name === "up") {
    key.preventDefault();
    state.list.moveUp();
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    state.list.moveDown();
    return true;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    if (state.list.options.length > 0) state.list.selectCurrent();
    return true;
  }
  return false;
}

function handleListKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    finish(state, 0);
    return;
  }
  navigateSelectList(state, key);
}

function handlePromptKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    setListMode(state);
  }
}

function handleInputKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    setListMode(state);
    return;
  }
  if (!state.inputQueue[state.inputIndex]?.options) return;
  navigateSelectList(state, key);
}

function handleConfirmKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    setListMode(state);
    return;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    const entry = state.pending;
    if (!entry) return;
    state.inputQueue = entry.inputs ?? [];
    state.inputIndex = 0;
    state.inputValues = {};
    advanceInput(state, entry);
  }
}

function handleRunKey(state: PickerState, key: KeyEvent): void {
  if (state.running) return;
  if (key.name === "escape" || key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    finish(state, 1);
  }
}

export function handlePickerKey(state: PickerState, key: KeyEvent): void {
  if (state.mode === "confirm") return handleConfirmKey(state, key);
  if (state.mode === "input") return handleInputKey(state, key);
  if (state.mode === "prompt") return handlePromptKey(state, key);
  if (state.mode === "run") return handleRunKey(state, key);
  handleListKey(state, key);
}

/** herdr prefix-key C0 bytes sit in the popup PTY; drop buffered + ignore late leaks. */
export function stdinLeakHandlers(): {
  drain: () => void;
  prepend: ((sequence: string) => boolean)[];
} {
  return {
    drain: () => {
      if (process.stdin.readableLength > 0) process.stdin.read(process.stdin.readableLength);
    },
    prepend: [
      (sequence) => {
        if (sequence.length !== 1) return false;
        const c = sequence.charCodeAt(0);
        return c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x1b;
      },
    ],
  };
}
