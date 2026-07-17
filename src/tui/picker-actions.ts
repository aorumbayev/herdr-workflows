import type {
  CliRenderer,
  InputRenderable,
  KeyEvent,
  SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import { sanitizeDisplay } from "../adapter/stdin";
import type { AgentsConfig, SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import { runWorkflow } from "../runner";
import type { WorkflowListEntry } from "../workflows";
import {
  buildPickerOptions,
  filterWorkflowEntries,
  formatInvalidLines,
  formatRunProgress,
  type PickerRowValue,
} from "./picker-rows";
import { truncate } from "./text";

export type PickerState = {
  mode: "list" | "prompt" | "run";
  entries: WorkflowListEntry[];
  pending?: WorkflowListEntry;
  exit?: { code: number };
  running: boolean;
  progressLines: string[];
  repoRoot: string;
  agents: AgentsConfig;
  sessions: SessionsConfig;
  ctx: InvocationContext;
  renderer: CliRenderer;
  filter: InputRenderable;
  list: SelectRenderable;
  status: TextRenderable;
  invalid: TextRenderable;
  promptInput: InputRenderable;
  footer: TextRenderable;
};

export const LIST_HINT = "type filter · ↑↓ move · enter run · esc cancel";
const PROMPT_HINT = "enter submit · esc back";
const FAIL_HINT = "enter/esc close";

export function applyFilter(state: PickerState): void {
  const { valid, invalid } = filterWorkflowEntries(state.entries, state.filter.value);
  state.list.options = buildPickerOptions(valid);
  if (state.list.options.length > 0) {
    state.list.setSelectedIndex(
      Math.min(state.list.getSelectedIndex(), state.list.options.length - 1),
    );
  }
  const lines = formatInvalidLines(invalid);
  state.invalid.content = lines;
  state.invalid.visible = lines.length > 0;
}

export function setListMode(state: PickerState): void {
  state.mode = "list";
  state.pending = undefined;
  state.progressLines = [];
  state.promptInput.visible = false;
  state.promptInput.value = "";
  state.filter.visible = true;
  state.list.visible = true;
  state.list.flexGrow = 1;
  state.status.visible = false;
  state.status.content = "";
  state.status.flexGrow = 0;
  state.footer.content = LIST_HINT;
  applyFilter(state);
  state.filter.focus();
}

function setPromptMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "prompt";
  state.pending = entry;
  state.filter.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.invalid.visible = false;
  state.status.visible = true;
  state.status.flexGrow = 0;
  state.status.content = entry.name;
  state.promptInput.visible = true;
  state.promptInput.value = "";
  state.footer.content = PROMPT_HINT;
  state.promptInput.focus();
}

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  state.filter.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.invalid.visible = false;
  state.promptInput.visible = false;
  state.status.visible = true;
  state.status.flexGrow = 1;
  state.status.content = formatRunProgress(entry.name, []);
  state.footer.content = "running…";
}

function finish(state: PickerState, code: number): void {
  state.exit = { code };
  state.renderer.destroy();
}

export function acceptWorkflow(state: PickerState, entry: WorkflowListEntry): void {
  if (entry.needsPrompt) {
    setPromptMode(state, entry);
    return;
  }
  void startRun(state, entry, "");
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
  setRunMode(state, entry);
  const result = await runWorkflow({
    name: entry.name,
    repoRoot: state.repoRoot,
    agents: state.agents,
    sessions: state.sessions,
    ctx: state.ctx,
    prompt: sanitizeDisplay(prompt),
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

function handleListKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    finish(state, 0);
    return;
  }
  if (key.name === "up") {
    key.preventDefault();
    state.list.moveUp();
    return;
  }
  if (key.name === "down") {
    key.preventDefault();
    state.list.moveDown();
    return;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    if (state.list.options.length === 0) return;
    state.list.selectCurrent();
  }
}

function handlePromptKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    setListMode(state);
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
