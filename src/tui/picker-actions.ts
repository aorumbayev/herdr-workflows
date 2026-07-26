import type { KeyEvent } from "@opentui/core";
import { finish, setListMode, type PickerState } from "./picker-modes";
import { prepareWorkflow } from "./picker-run";

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
  navigateSelectList(state, key);
}

function handleInputKey(state: PickerState, key: KeyEvent): void {
  if (!state.inputQueue[state.inputIndex]?.options) return;
  navigateSelectList(state, key);
}

function handleConfirmKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    const entry = state.pending;
    if (!entry) return;
    void prepareWorkflow(state, entry);
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
  if (state.mode === "run") return handleRunKey(state, key);
  if (key.name === "escape") {
    key.preventDefault();
    if (state.mode === "list") finish(state, 0);
    else setListMode(state);
    return;
  }
  if (state.mode === "confirm") return handleConfirmKey(state, key);
  if (state.mode === "input") return handleInputKey(state, key);
  if (state.mode === "prompt") return;
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
