import {
  Box,
  BoxRenderable,
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

export function pickerContentWidth(rendererWidth: number): number {
  return Math.max(0, rendererWidth - 2);
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
  const needle = filter.toLowerCase();
  const matched = filter
    ? visible.filter((e) => {
        const title = workflowDisplayTitle(e.name, e.title).toLowerCase();
        return title.includes(needle) || e.name.toLowerCase().includes(needle);
      })
    : visible;
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

// @opentui/core SelectRenderable: name text starts at contentX+1+indicatorWidth (1 pad + 2-col indicator).
const SELECT_NAME_OFFSET = 3;
const LOCATION_WIDTH = 7;
const WARNING_WIDTH = 2;

function formatPickerRowName(
  title: string,
  location: "global" | "repo" | "invalid",
  warned: boolean,
  rowWidth: number,
): string {
  const titleW = Math.max(0, rowWidth - SELECT_NAME_OFFSET - 1 - WARNING_WIDTH - LOCATION_WIDTH);
  const warning = warned ? "! " : "  ";
  return `${truncate(title, titleW).padEnd(titleW)} ${warning}${location.padStart(LOCATION_WIDTH)}`;
}

export function buildPickerOptions(valid: WorkflowListEntry[], rowWidth: number): SelectOption[] {
  return valid.map((entry) => ({
    name: formatPickerRowName(
      workflowDisplayTitle(entry.name, entry.title),
      entry.source === "repo" ? "repo" : "global",
      entrySensitivity(entry).length > 0,
      rowWidth,
    ),
    description: entry.description?.trim() || entry.name,
    value: { entry } satisfies PickerRowValue,
  }));
}

function buildInvalidOptions(invalid: WorkflowListEntry[], rowWidth: number): SelectOption[] {
  return invalid.map((entry) => ({
    name: formatPickerRowName(
      workflowDisplayTitle(entry.name, entry.title),
      "invalid",
      entrySensitivity(entry).length > 0,
      rowWidth,
    ),
    description: stripFilePrefix(entry.error ?? "", entry.file),
    value: { entry } satisfies PickerRowValue,
  }));
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
  contentWidth: number;
  renderer: CliRenderer;
  filterRow: BoxRenderable;
  filter: InputRenderable;
  listBlock: BoxRenderable;
  list: SelectRenderable;
  status: TextRenderable;
  detail: TextRenderable;
  rule: TextRenderable;
  promptInput: InputRenderable;
  footer: TextRenderable;
};

export const LIST_HINT = "enter run · ^e edit · ^y share · ^o import · esc";
const PROMPT_HINT = "enter submit · esc back";
const CHOICE_HINT = "type filter · ↑↓ move · enter select · esc back";
const RUN_HINT = "esc dismiss · run continues";
const FAIL_HINT = "enter/esc close";

function formatRule(contentWidth: number): string {
  return `  ${"-".repeat(Math.max(0, contentWidth - 4))}`;
}

function formatListFooter(contentWidth: number, selectedIndex: number, total: number): string {
  if (total === 0) return truncate(LIST_HINT, contentWidth);
  const counter = `${selectedIndex + 1}/${total}`;
  if (LIST_HINT.length + 1 + counter.length <= contentWidth) {
    const pad = contentWidth - LIST_HINT.length - counter.length;
    return `${LIST_HINT}${" ".repeat(pad)}${counter}`;
  }
  const hint = truncate(LIST_HINT, Math.max(0, contentWidth - counter.length - 1));
  const pad = Math.max(0, contentWidth - hint.length - counter.length);
  return `${hint}${" ".repeat(pad)}${counter}`;
}

function formatDetailLine(description: string, contentWidth: number): string {
  if (!description) return "";
  return `  ${truncate(description, Math.max(0, contentWidth - 2))}`;
}

function updateDetail(state: PickerState): void {
  if (state.mode !== "list") {
    state.detail.content = "";
    return;
  }
  const option =
    state.list.options.length > 0 ? state.list.options[state.list.getSelectedIndex()] : undefined;
  state.detail.content = formatDetailLine(option?.description ?? "", state.contentWidth);
}

function updateListFooter(state: PickerState): void {
  if (state.mode !== "list") return;
  state.footer.content = formatListFooter(
    state.contentWidth,
    state.list.getSelectedIndex(),
    state.list.options.length,
  );
}

function refreshListChrome(state: PickerState): void {
  updateDetail(state);
  updateListFooter(state);
}

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
  setListOptions(state, [
    ...buildPickerOptions(valid, state.contentWidth),
    ...buildInvalidOptions(invalid, state.contentWidth),
  ]);
  refreshListChrome(state);
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
  state.filterRow.visible = false;
  state.listBlock.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.detail.visible = false;
  state.rule.visible = false;
  state.promptInput.visible = false;
}

function showBrowserChrome(state: PickerState): void {
  state.promptInput.visible = false;
  state.filterRow.visible = true;
  state.filter.visible = true;
  state.filter.placeholder = "filter…";
  state.filter.value = "";
  state.listBlock.visible = true;
  state.list.visible = true;
  state.list.flexGrow = 0;
  state.list.height = 6;
}

function showListChrome(state: PickerState): void {
  state.detail.visible = true;
  state.rule.visible = true;
  state.rule.content = formatRule(state.contentWidth);
}

function hideListChrome(state: PickerState): void {
  state.detail.visible = false;
  state.detail.content = "";
  state.rule.visible = false;
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
  showListChrome(state);
  state.promptInput.value = "";
  state.status.visible = false;
  state.status.content = "";
  state.status.flexGrow = 0;
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
  hideListChrome(state);
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
  state.filterRow.visible = false;
  state.filter.visible = false;
  state.listBlock.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  focusTextField(state, `${spec.name}…`, spec.default ?? "");
}

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  hideBrowserChrome(state);
  hideListChrome(state);
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
    updateListFooter(state);
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
  if (entry.error) {
    const err = stripFilePrefix(entry.error, entry.file);
    state.detail.content = formatDetailLine(err, state.contentWidth);
    updateListFooter(state);
    return;
  }
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
        state.progressLines.push(truncate(line, state.contentWidth));
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
  | "contentWidth"
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
      Box(
        { id: "filter-row", flexDirection: "row", width: "100%" },
        Text({ content: "/ ", ...theme.text }),
        Input({ id: "filter", flexGrow: 1, placeholder: "filter…", ...theme.input }),
      ),
      Box(
        { id: "list-block", flexDirection: "column", flexGrow: 0 },
        Text({ content: " " }),
        Select({
          id: "list",
          flexGrow: 0,
          height: 6,
          options: [],
          showDescription: false,
          showScrollIndicator: false,
          wrapSelection: true,
          itemSpacing: 0,
          ...theme.select,
        }),
        Text({ content: " " }),
      ),
      Text({
        id: "status",
        content: "",
        visible: false,
        flexGrow: 1,
        ...theme.text,
      }),
      Text({ id: "detail", content: "", attributes: TextAttributes.DIM, ...theme.text }),
      Text({
        id: "rule",
        content: "",
        attributes: TextAttributes.DIM,
        ...theme.text,
      }),
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
    filterRow: renderer.root.findDescendantById("filter-row") as BoxRenderable,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    listBlock: renderer.root.findDescendantById("list-block") as BoxRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    status: renderer.root.findDescendantById("status") as TextRenderable,
    detail: renderer.root.findDescendantById("detail") as TextRenderable,
    rule: renderer.root.findDescendantById("rule") as TextRenderable,
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
  state.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (state.mode !== "list") return;
    refreshListChrome(state);
  });
  state.filter.on(InputRenderableEvents.INPUT, () => {
    if (state.mode === "list") applyFilter(state);
    else if (state.mode === "input" && state.choiceOptions.length > 0) applyChoiceFilter(state);
  });
  state.promptInput.on(InputRenderableEvents.ENTER, (value) =>
    state.mode === "input" ? submitInputText(state, value) : submitPrompt(state, value),
  );
  state.renderer.keyInput.on("keypress", (key) => handlePickerKey(state, key));
  state.renderer.on("resize", (width: number) => {
    state.contentWidth = pickerContentWidth(width);
    state.rule.content = formatRule(state.contentWidth);
    if (state.mode === "list") applyFilter(state);
  });
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
  const ui = mountPickerUi(renderer, theme);

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
    contentWidth: pickerContentWidth(renderer.width),
    ...ui,
  };

  bindPickerEvents(state);
  setListMode(state);

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });

  return state.exit?.code ?? 0;
}
