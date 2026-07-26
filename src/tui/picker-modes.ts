import type {
  CliRenderer,
  InputRenderable,
  SelectOption,
  SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import type { AgentsConfig, SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import {
  buildPickerOptions,
  filterChoiceOptions,
  filterWorkflowEntries,
  formatInvalidLines,
  formatRunProgress,
} from "./picker-rows";

export type PickerState = {
  mode: "list" | "input" | "prompt" | "run" | "confirm";
  entries: WorkflowListEntry[];
  pending?: WorkflowListEntry;
  inputQueue: InputSpec[];
  inputIndex: number;
  inputValues: Record<string, string>;
  choiceOptions: string[];
  exit?: { code: number };
  running: boolean;
  progressLines: string[];
  repoRoot: string;
  agents: AgentsConfig;
  sessions: SessionsConfig;
  ctx: InvocationContext;
  loadWorkflow: (
    entry: WorkflowListEntry,
    repoRoot: string,
    agents: Iterable<string>,
  ) => Promise<LoadedWorkflow>;
  workflow?: LoadedWorkflow;
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
const CHOICE_HINT = "type filter · ↑↓ move · enter select · esc back";

function setListOptions(state: PickerState, options: SelectOption[]): void {
  state.list.options = options;
  if (state.list.options.length > 0) {
    state.list.setSelectedIndex(
      Math.min(state.list.getSelectedIndex(), state.list.options.length - 1),
    );
  }
}

export function applyFilter(state: PickerState): void {
  const { valid, invalid } = filterWorkflowEntries(state.entries, state.filter.value);
  setListOptions(state, buildPickerOptions(valid));
  const lines = formatInvalidLines(invalid);
  state.invalid.content = lines;
  state.invalid.visible = lines.length > 0;
}

export function applyChoiceFilter(state: PickerState): void {
  const matched = filterChoiceOptions(state.choiceOptions, state.filter.value);
  setListOptions(
    state,
    matched.map((option) => ({
      name: option,
      description: "",
      value: option,
    })),
  );
}

export function setListMode(state: PickerState): void {
  state.mode = "list";
  state.pending = undefined;
  state.workflow = undefined;
  state.inputQueue = [];
  state.inputIndex = 0;
  state.inputValues = {};
  state.choiceOptions = [];
  state.progressLines = [];
  showBrowserChrome(state);
  state.promptInput.value = "";
  state.status.visible = false;
  state.status.content = "";
  state.status.flexGrow = 0;
  state.footer.content = LIST_HINT;
  applyFilter(state);
  state.filter.focus();
}

function hideBrowserChrome(state: PickerState): void {
  state.filter.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.invalid.visible = false;
  state.promptInput.visible = false;
}

function showBrowserChrome(state: PickerState): void {
  state.promptInput.visible = false;
  state.filter.visible = true;
  state.filter.placeholder = "filter…";
  state.filter.value = "";
  state.list.visible = true;
  state.list.flexGrow = 1;
}

function showStatus(state: PickerState, content: string, flexGrow = 0): void {
  state.status.visible = true;
  state.status.flexGrow = flexGrow;
  state.status.content = content;
}

function focusTextField(state: PickerState, placeholder: string, value: string): void {
  state.promptInput.visible = true;
  state.promptInput.placeholder = placeholder;
  state.promptInput.value = value;
  state.footer.content = PROMPT_HINT;
  state.promptInput.focus();
}

export function setConfirmMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "confirm";
  state.pending = entry;
  hideBrowserChrome(state);
  showStatus(state, `${entry.name} · workflow may run shell commands`);
  state.footer.content = "enter run · esc cancel";
}

export function setPromptMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "prompt";
  state.pending = entry;
  hideBrowserChrome(state);
  showStatus(state, entry.name);
  focusTextField(state, "prompt…", "");
}

export function setInputMode(state: PickerState, entry: WorkflowListEntry, spec: InputSpec): void {
  state.mode = "input";
  state.pending = entry;
  state.invalid.visible = false;
  showStatus(state, `${entry.name} · ${spec.label}`);
  if (spec.options) {
    state.choiceOptions = spec.options;
    showBrowserChrome(state);
    applyChoiceFilter(state);
    const preselect = spec.default
      ? state.list.options.findIndex((o) => o.value === spec.default)
      : 0;
    state.list.setSelectedIndex(Math.max(preselect, 0));
    state.footer.content = CHOICE_HINT;
    state.filter.focus();
    return;
  }
  state.choiceOptions = [];
  state.filter.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  focusTextField(state, `${spec.label}…`, spec.default ?? "");
}

export function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  hideBrowserChrome(state);
  showStatus(state, formatRunProgress(entry.name, []), 1);
  state.footer.content = "running…";
}

export function finish(state: PickerState, code: number): void {
  state.exit = { code };
  state.renderer.destroy();
}
