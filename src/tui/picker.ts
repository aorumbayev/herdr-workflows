import { basename } from "node:path";
import {
  Box,
  createCliRenderer,
  Input,
  InputRenderable,
  InputRenderableEvents,
  Select,
  SelectRenderable,
  SelectRenderableEvents,
  Text,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import type { AgentsConfig, InvocationContext, SessionsConfig } from "../config";
import { sanitizeDisplay } from "../herdr";
import { runWorkflow } from "../run/runner";
import { loadWorkflowEntry } from "../workflow/load";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { resolveHostTheme, type HostTheme } from "./theme";

function stripFilePrefix(error: string, file: string): string {
  return error.startsWith(file) ? error.slice(file.length).replace(/^[,:]\s*/, "") : error;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

type PickerRowValue = { entry: WorkflowListEntry };

// `hidden: true` workflows are background halves — runnable via `hwf run`, kept out of the picker.
const isPickerVisible = (e: WorkflowListEntry): boolean => !e.hidden;

export function hasVisibleEntries(entries: WorkflowListEntry[]): boolean {
  return entries.some(isPickerVisible);
}

export function filterWorkflowEntries(
  entries: WorkflowListEntry[],
  filter: string,
): { valid: WorkflowListEntry[]; invalid: WorkflowListEntry[] } {
  const visible = entries.filter(isPickerVisible);
  const matched = filter ? visible.filter((e) => e.name.includes(filter)) : visible;
  return {
    valid: matched.filter((e) => !e.error),
    invalid: matched.filter((e) => e.error),
  };
}

export function buildPickerOptions(valid: WorkflowListEntry[]): SelectOption[] {
  return valid.map((entry) => {
    const parts = [entry.name, entry.source];
    if (entry.inputs?.length) parts.push("inputs");
    if (entry.needsPrompt) parts.push("prompt");
    return {
      name: parts.join(" · "),
      description: "",
      value: { entry } satisfies PickerRowValue,
    };
  });
}

export function formatInvalidLines(invalid: WorkflowListEntry[]): string {
  if (invalid.length === 0) return "";
  return invalid
    .map((e) => `${e.name} — invalid: ${truncate(stripFilePrefix(e.error ?? "", e.file), 44)}`)
    .join("\n");
}

export function formatRunProgress(
  name: string,
  lines: string[],
  terminal?: { ok: boolean; detail: string },
): string {
  const body = lines.length > 0 ? lines.join("\n") : "…";
  if (!terminal) return `${name}\n${body}`;
  const status = terminal.ok ? "Done." : `Failed · ${terminal.detail}`;
  return `${name}\n${body}\n\n${status}`;
}

export function filterChoiceOptions(options: string[], filter: string): string[] {
  return filter ? options.filter((option) => option.includes(filter)) : options;
}

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

const LIST_HINT = "type filter · ↑↓ move · enter run · esc cancel";
const PROMPT_HINT = "enter submit · esc back";
const CHOICE_HINT = "type filter · ↑↓ move · enter select · esc back";
const FAIL_HINT = "enter/esc close";

function setListOptions(state: PickerState, options: SelectOption[]): void {
  state.list.options = options;
  if (state.list.options.length > 0) {
    state.list.setSelectedIndex(
      Math.min(state.list.getSelectedIndex(), state.list.options.length - 1),
    );
  }
}

function applyFilter(state: PickerState): void {
  const { valid, invalid } = filterWorkflowEntries(state.entries, state.filter.value);
  setListOptions(state, buildPickerOptions(valid));
  const lines = formatInvalidLines(invalid);
  state.invalid.content = lines;
  state.invalid.visible = lines.length > 0;
}

function applyChoiceFilter(state: PickerState): void {
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

function setListMode(state: PickerState): void {
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

function setConfirmMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "confirm";
  state.pending = entry;
  hideBrowserChrome(state);
  showStatus(state, `${entry.name} · workflow may run shell commands`);
  state.footer.content = "enter run · esc cancel";
}

function setPromptMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "prompt";
  state.pending = entry;
  hideBrowserChrome(state);
  showStatus(state, entry.name);
  focusTextField(state, "prompt…", "");
}

function setInputMode(state: PickerState, entry: WorkflowListEntry, spec: InputSpec): void {
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

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  hideBrowserChrome(state);
  showStatus(state, formatRunProgress(entry.name, []), 1);
  state.footer.content = "running…";
}

function finish(state: PickerState, code: number): void {
  state.exit = { code };
  state.renderer.destroy();
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

function handlePickerKey(state: PickerState, key: KeyEvent): void {
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
  navigateSelectList(state, key);
}

/** herdr prefix-key C0 bytes sit in the popup PTY; drop buffered + ignore late leaks. */
function stdinLeakHandlers(): {
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

function submitInputChoice(state: PickerState, value: string): void {
  if (state.mode === "input") storeInput(state, value);
}

function submitInputText(state: PickerState, value: string): void {
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

async function prepareWorkflow(
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

function submitPrompt(state: PickerState, value: string): void {
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

function mountPickerUi(
  renderer: CliRenderer,
  theme: HostTheme,
  repoRoot: string,
): Omit<
  PickerState,
  | "mode"
  | "entries"
  | "pending"
  | "inputQueue"
  | "inputIndex"
  | "inputValues"
  | "choiceOptions"
  | "exit"
  | "running"
  | "progressLines"
  | "repoRoot"
  | "agents"
  | "sessions"
  | "ctx"
  | "workflow"
  | "loadWorkflow"
> {
  renderer.root.add(
    Box(
      {
        flexDirection: "column",
        paddingX: 1,
        paddingY: 0,
        width: "100%",
        height: "100%",
        gap: 0,
      },
      Text({ content: `Launch · ${basename(repoRoot)}`, ...theme.text }),
      Input({ id: "filter", width: "100%", placeholder: "filter…", ...theme.input }),
      Select({
        id: "list",
        flexGrow: 1,
        options: [],
        showDescription: false,
        showScrollIndicator: true,
        wrapSelection: true,
        itemSpacing: 0,
        ...theme.select,
      }),
      Text({
        id: "status",
        content: "",
        visible: false,
        flexGrow: 1,
        ...theme.text,
      }),
      Text({ id: "invalid", content: "", attributes: TextAttributes.DIM, ...theme.text }),
      Input({
        id: "prompt-input",
        visible: false,
        width: "100%",
        placeholder: "prompt…",
        ...theme.input,
      }),
      Text({ id: "footer", content: LIST_HINT, attributes: TextAttributes.DIM, ...theme.text }),
    ),
  );
  return {
    renderer,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    status: renderer.root.findDescendantById("status") as TextRenderable,
    invalid: renderer.root.findDescendantById("invalid") as TextRenderable,
    promptInput: renderer.root.findDescendantById("prompt-input") as InputRenderable,
    footer: renderer.root.findDescendantById("footer") as TextRenderable,
  };
}

function bindPickerEvents(state: PickerState): void {
  state.list.on(SelectRenderableEvents.ITEM_SELECTED, (_i, option) => {
    if (state.mode === "input") {
      if (typeof option.value === "string") submitInputChoice(state, option.value);
      return;
    }
    if (state.mode !== "list") return;
    const value = option.value as PickerRowValue | undefined;
    if (!value) return;
    acceptWorkflow(state, value.entry);
  });
  state.filter.on(InputRenderableEvents.INPUT, () => {
    if (state.mode === "list") applyFilter(state);
    else if (state.mode === "input" && state.choiceOptions.length > 0) applyChoiceFilter(state);
  });
  state.promptInput.on(InputRenderableEvents.ENTER, (value) =>
    state.mode === "input" ? submitInputText(state, value) : submitPrompt(state, value),
  );
  state.renderer.keyInput.on("keypress", (key) => handlePickerKey(state, key));
}

export type PickerSessionOpts = {
  entries: WorkflowListEntry[];
  repoRoot: string;
  agents: AgentsConfig;
  sessions: SessionsConfig;
  ctx: InvocationContext;
};

export async function runPickerSession(opts: PickerSessionOpts): Promise<number> {
  const leak = stdinLeakHandlers();
  leak.drain();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    prependInputHandlers: leak.prepend,
  });
  const theme = await resolveHostTheme(renderer);
  const ui = mountPickerUi(renderer, theme, opts.repoRoot);

  const state: PickerState = {
    mode: "list",
    entries: opts.entries,
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    choiceOptions: [],
    running: false,
    progressLines: [],
    repoRoot: opts.repoRoot,
    agents: opts.agents,
    sessions: opts.sessions,
    ctx: opts.ctx,
    loadWorkflow: loadWorkflowEntry,
    ...ui,
  };

  bindPickerEvents(state);
  setListMode(state);

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });

  return state.exit?.code ?? 0;
}
