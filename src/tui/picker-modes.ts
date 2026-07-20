import type { CliRenderer, InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import type { AgentsConfig, SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { InputSpec, WorkflowListEntry } from "../workflows";
import {
  buildPickerOptions,
  filterWorkflowEntries,
  formatInvalidLines,
  formatRunProgress,
} from "./picker-rows";

export type PickerState = {
  mode: "list" | "input" | "prompt" | "run";
  entries: WorkflowListEntry[];
  pending?: WorkflowListEntry;
  inputQueue: InputSpec[];
  inputIndex: number;
  inputValues: Record<string, string>;
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
const CHOICE_HINT = "↑↓ move · enter select · esc back";

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
  state.inputQueue = [];
  state.inputIndex = 0;
  state.inputValues = {};
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

export function setPromptMode(state: PickerState, entry: WorkflowListEntry): void {
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

export function setInputMode(state: PickerState, entry: WorkflowListEntry, spec: InputSpec): void {
  state.mode = "input";
  state.pending = entry;
  state.filter.visible = false;
  state.invalid.visible = false;
  state.status.visible = true;
  state.status.flexGrow = 0;
  state.status.content = `${entry.name} · ${spec.label}`;
  if (spec.options) {
    state.promptInput.visible = false;
    state.list.visible = true;
    state.list.flexGrow = 1;
    state.list.options = spec.options.map((option) => ({
      name: option,
      description: "",
      value: option,
    }));
    const preselect = spec.default ? spec.options.indexOf(spec.default) : 0;
    state.list.setSelectedIndex(Math.max(preselect, 0));
    state.footer.content = CHOICE_HINT;
    state.list.focus();
    return;
  }
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.promptInput.visible = true;
  state.promptInput.value = spec.default ?? "";
  state.footer.content = PROMPT_HINT;
  state.promptInput.focus();
}

export function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
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

export function finish(state: PickerState, code: number): void {
  state.exit = { code };
  state.renderer.destroy();
}
