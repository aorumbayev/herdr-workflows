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
import type { InvocationContext, WorkflowsConfig } from "../config";
import { sanitizeDisplay } from "../herdr";
import { loadWorkflowEntry } from "../workflow/load";
import {
  analyzeResolvedSensitivity,
  sensitivityLabels,
  workflowDisplayTitle,
} from "../workflow/trust";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { parseWebRoute } from "../web/route";
import {
  launchDetachedRun,
  launchDetachedWeb,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "./run-launch";
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

export function entrySensitivity(entry: WorkflowListEntry): string[] {
  return sensitivityLabels({
    hasCommands: entry.hasCommands === true,
    hasTranscript: entry.needsTranscript === true,
    sensitiveMethods: entry.sensitiveMethods ?? [],
    unresolvedChildren: entry.unresolvedChildren ?? [],
  });
}

export function buildPickerOptions(valid: WorkflowListEntry[]): SelectOption[] {
  return valid.map((entry) => {
    const title = workflowDisplayTitle(entry.name, entry.title);
    const parts = [title, entry.source === "repo" ? "repo" : "global"];
    if (entry.inputs?.length) parts.push("inputs");
    parts.push(...entrySensitivity(entry));
    return {
      name: parts.join(" · "),
      description: entry.description?.trim() || entry.name,
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
  mode: "list" | "input" | "prompt" | "run";
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
  config: WorkflowsConfig;
  ctx: InvocationContext;
  loadWorkflow: (
    entry: WorkflowListEntry,
    repoRoot: string,
    config: WorkflowsConfig,
  ) => Promise<LoadedWorkflow>;
  launchRun?: (req: LaunchRunRequest) => DetachedRunHandle;
  launchWeb?: (req: LaunchWebRequest) => void;
  runHandle?: DetachedRunHandle;
  workflow?: LoadedWorkflow;
  renderer: CliRenderer;
  filter: InputRenderable;
  list: SelectRenderable;
  status: TextRenderable;
  invalid: TextRenderable;
  promptInput: InputRenderable;
  footer: TextRenderable;
};

export const LIST_HINT = "type filter · ↑↓ · enter run · ^e edit · ^y share · ^o import · esc";
const PROMPT_HINT = "enter submit · esc back";
const CHOICE_HINT = "type filter · ↑↓ move · enter select · esc back";
const RUN_HINT = "esc dismiss · run continues";
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

export function formatInputPrompt(spec: InputSpec): string {
  const desc = spec.description?.trim();
  const label = desc ? `${spec.name} — ${desc}` : spec.name;
  if (spec.type === "text") return `${label} · type free text`;
  return `${label} · type to filter, enter to select`;
}

function inputStatusLine(entry: WorkflowListEntry, spec: InputSpec): string {
  const title = workflowDisplayTitle(entry.name, entry.title);
  return `${title} · ${entry.source}\n${formatInputPrompt(spec)}`;
}

function emptyInputOptionsError(spec: InputSpec): string {
  if (spec.type === "profile") {
    return `input '${spec.name}': no profiles configured; run \`hwf init\` or \`hwf init --global\``;
  }
  return `input '${spec.name}': choice produced no options`;
}

function setInputMode(state: PickerState, entry: WorkflowListEntry, spec: InputSpec): void {
  if ((spec.type === "choice" || spec.type === "profile") && (spec.options?.length ?? 0) === 0) {
    showFailure(state, entry, new Error(emptyInputOptionsError(spec)));
    return;
  }
  state.mode = "input";
  state.pending = entry;
  state.invalid.visible = false;
  showStatus(state, inputStatusLine(entry, spec));
  if (spec.type === "choice" || spec.type === "profile") {
    state.choiceOptions = spec.options ?? [];
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
  focusTextField(state, `${spec.name}…`, spec.default ?? "");
}

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  hideBrowserChrome(state);
  showStatus(state, formatRunProgress(entry.name, []), 1);
  state.footer.content = RUN_HINT;
}

function finish(state: PickerState, code: number): void {
  state.runHandle?.detach();
  state.runHandle = undefined;
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
  const spec = state.inputQueue[state.inputIndex];
  if (!spec || (spec.type !== "choice" && spec.type !== "profile")) return;
  navigateSelectList(state, key);
}

function handleRunKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    finish(state, 0);
    return;
  }
  if (state.running) return;
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    finish(state, 1);
  }
}

/** Selected valid row in list mode, or undefined when the filtered list is empty. */
export function selectedListEntry(state: PickerState): WorkflowListEntry | undefined {
  if (state.list.options.length === 0) return undefined;
  const option = state.list.options[state.list.getSelectedIndex()];
  const value = option?.value as PickerRowValue | undefined;
  return value?.entry;
}

/**
 * Resolve a list-mode workbench shortcut.
 * `undefined` = not a workbench shortcut; `"noop"` = recognized but no launch;
 * otherwise a validated route hash for `hwf web`.
 */
export function resolveListWorkbenchRoute(
  key: { name: string; ctrl: boolean },
  selected: WorkflowListEntry | undefined,
): string | "noop" | undefined {
  if (!key.ctrl) return undefined;
  const name = key.name.toLowerCase();
  if (name === "o") return "import";
  if (name !== "e" && name !== "y") return undefined;
  if (!selected) return "noop";
  const kind = name === "e" ? "w" : "share";
  const route = `${kind}=${selected.source}:${selected.name}`;
  return parseWebRoute(route) ? route : "noop";
}

export function launchWorkbenchRoute(state: PickerState, route: string): void {
  const parsed = parseWebRoute(route);
  if (!parsed) return;
  const launch = state.launchWeb ?? launchDetachedWeb;
  try {
    launch({ route: parsed.hash, repoRoot: state.repoRoot });
  } catch (error) {
    const detail = truncate(error instanceof Error ? error.message : String(error), 60);
    showStatus(state, `workbench failed · ${detail}`);
    state.footer.content = LIST_HINT;
    return;
  }
  finish(state, 0);
}

export function tryListWorkbenchShortcut(state: PickerState, key: KeyEvent): boolean {
  if (state.mode !== "list") return false;
  const resolved = resolveListWorkbenchRoute(key, selectedListEntry(state));
  if (resolved === undefined) return false;
  key.preventDefault();
  if (resolved === "noop") return true;
  launchWorkbenchRoute(state, resolved);
  return true;
}

function handlePickerKey(state: PickerState, key: KeyEvent): void {
  if (state.mode === "run") return handleRunKey(state, key);
  if (key.name === "escape") {
    key.preventDefault();
    if (state.mode === "list") finish(state, 0);
    else setListMode(state);
    return;
  }
  if (state.mode === "input") return handleInputKey(state, key);
  if (state.mode === "prompt") return;
  if (tryListWorkbenchShortcut(state, key)) return;
  navigateSelectList(state, key);
}

/** herdr prefix-key C0 bytes sit in the popup PTY; drop buffered + ignore late leaks. */
const WORKBENCH_SHORTCUT_C0 = new Set([
  0x05, // Ctrl+E
  0x0f, // Ctrl+O
  0x19, // Ctrl+Y
]);

/**
 * True when a raw stdin sequence should be dropped as a herdr prefix-key leak.
 * Keeps tab/newline/CR/escape and Ctrl+E/O/Y so OpenTUI can emit workbench keypresses.
 */
export function shouldDropStdinLeakSequence(sequence: string): boolean {
  if (sequence.length !== 1) return false;
  const c = sequence.charCodeAt(0);
  if (c >= 0x20) return false;
  if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b) return false;
  if (WORKBENCH_SHORTCUT_C0.has(c)) return false;
  return true;
}

function stdinLeakHandlers(): {
  drain: () => void;
  prepend: ((sequence: string) => boolean)[];
} {
  return {
    drain: () => {
      if (process.stdin.readableLength > 0) process.stdin.read(process.stdin.readableLength);
    },
    prepend: [shouldDropStdinLeakSequence],
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

/** Declared inputs first, then run. */
function advanceInput(state: PickerState, entry: WorkflowListEntry): void {
  const spec = state.inputQueue[state.inputIndex];
  if (spec) return setInputMode(state, entry, spec);
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
  void prepareWorkflow(state, entry);
}

async function prepareWorkflow(state: PickerState, entry: WorkflowListEntry): Promise<void> {
  setRunMode(state, entry);
  try {
    const workflow =
      state.workflow ?? (await state.loadWorkflow(entry, state.repoRoot, state.config));
    entry.title = workflow.title;
    entry.description = workflow.description;
    entry.inputs = workflow.inputs;
    entry.repoOwned = workflow.repoOwned;
    const resolved = await analyzeResolvedSensitivity(
      {
        name: workflow.name,
        steps: workflow.steps,
        returns: workflow.returns,
        onFailure: workflow.onFailure,
      },
      state.repoRoot,
    );
    entry.hasCommands = resolved.hasCommands;
    entry.needsTranscript = resolved.hasTranscript;
    entry.sensitiveMethods = resolved.sensitiveMethods;
    entry.unresolvedChildren = resolved.unresolvedChildren;
    const flags = entrySensitivity(entry);
    state.pending = entry;
    state.workflow = workflow;
    state.inputQueue = entry.inputs ?? [];
    state.inputIndex = 0;
    state.inputValues = {};
    state.running = false;
    if (flags.length > 0) {
      showStatus(
        state,
        `${workflowDisplayTitle(entry.name, entry.title)} · ${entry.source} · ${flags.join(" · ")}`,
      );
    }
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
    state.workflow =
      state.workflow ?? (await state.loadWorkflow(entry, state.repoRoot, state.config));
    const launch = state.launchRun ?? launchDetachedRun;
    const handle = launch({
      name: entry.name,
      repoRoot: state.repoRoot,
      ctx: state.ctx,
      inputs,
      prompt: sanitizeDisplay(prompt),
      onProgressLine: (line) => {
        if (state.exit) return;
        state.progressLines.push(truncate(line, 48));
        state.status.content = formatRunProgress(entry.name, state.progressLines);
      },
    });
    state.runHandle = handle;
    const result = await handle.result;
    if (state.exit) return;
    state.runHandle = undefined;
    state.running = false;
    state.status.content = formatRunProgress(entry.name, state.progressLines, {
      ok: result.ok,
      detail: result.ok ? "" : result.detail,
    });
    if (result.ok) {
      finish(state, 0);
      return;
    }
    state.footer.content = FAIL_HINT;
  } catch (error) {
    state.runHandle = undefined;
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
  | "config"
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
        showDescription: true,
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
  config: WorkflowsConfig;
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
    config: opts.config,
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
