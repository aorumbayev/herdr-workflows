import { createCliRenderer, type KeyEvent, type SelectOption } from "@opentui/core";
import type { InvocationContext, WorkflowsConfig } from "../config";
import { loadConfig } from "../config";
import { listWorkflows, loadWorkflowEntry } from "../workflow/load";
import { createInputSession, type InputSession } from "../workflow/inputs";
import { analyzeResolvedSensitivity, workflowDisplayTitle } from "../workflow/trust";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { parseWebRoute } from "../web/endpoint";
import {
  deleteWorkflowFile,
  EMPTY_CATALOG_MESSAGE,
  EMPTY_LIST_HINT,
  formatPaletteBody,
  openExamplesInBrowser,
  PALETTE_HINT,
  DELETE_CONFIRM_HINT,
  resolvePaletteLetter,
  shareWorkflowCopy,
  type ResolvedPaletteAction,
} from "./picker-actions";
import { mountPickerChrome, type PickerChrome } from "./picker-chrome";
import {
  CHROME_SEP,
  buildInvalidOptions,
  buildPickerOptions,
  entrySensitivity,
  filterChoiceOptions,
  formatDetailLines,
  formatListFooter,
  formatPickerRowName,
  formatRule,
  formatRunProgress,
  stripFilePrefix,
  truncate,
} from "./picker-rows";
import { createRunsBrowser, type RunsBrowser } from "./runs-browser";
import {
  launchDetachedWeb,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "./run-launch";
import { resolveHostTheme, type HostTheme } from "./theme";
import {
  defaultPickerReleaseCheck,
  embeddedPluginVersion,
  formatFilterUpdateHint,
  startPickerUpdateCheck,
} from "./update-indicator";
export type CustomChoiceValue = { kind: "custom" };

export function isCustomChoiceValue(value: unknown): value is CustomChoiceValue {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "custom"
  );
}

export function shouldRestoreCustomChoiceText(
  hasAnswer: boolean,
  answer: string | undefined,
  options: string[],
  allowCustom: boolean,
): boolean {
  return hasAnswer && allowCustom && !options.includes(answer ?? "");
}

function syncInputSession(state: PickerState): void {
  const session = state.inputSession;
  if (!session) {
    state.inputValues = {};
    state.inputDomains = {};
    state.inputIndex = 0;
    return;
  }
  state.inputValues = session.values;
  state.inputDomains = session.domains;
  state.inputIndex = session.cursor;
}

const CUSTOM_CHOICE_LABEL = "custom...";
const CUSTOM_CHOICE_VALUE: CustomChoiceValue = { kind: "custom" };
const ELLIPSIS = "...";

function pickerContentWidth(rendererWidth: number): number {
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

export type PickerState = {
  mode: "list" | "input" | "run" | "palette" | "delete-confirm";
  entries: WorkflowListEntry[];
  pending?: WorkflowListEntry;
  deleteTarget?: WorkflowListEntry;
  /** True while a confirmed delete is in flight — further y/n/esc are ignored. */
  deleteInFlight?: boolean;
  inputQueue: InputSpec[];
  inputIndex: number;
  inputValues: Record<string, string>;
  inputDomains: Record<string, string[]>;
  /** Owns activation, options resolution, validation, and answer invalidation. */
  inputSession?: InputSession;
  choiceOptions: string[];
  customChoice: boolean;
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
  reloadEntries: () => Promise<WorkflowListEntry[]>;
  workflow?: LoadedWorkflow;
  contentWidth: number;
  theme: HostTheme;
  chrome: PickerChrome;
  /** Set when a newer published release is known; drives list-mode filter-row hint. */
  newerReleaseVersion?: string;
  savedWorkflowFilter: string;
  /** Workflow list row to reselect after palette/runs chrome restore. */
  savedListEntry?: WorkflowListEntry;
  runs: RunsBrowser;
};

export const LIST_HINT = `tab runs${CHROME_SEP}enter run${CHROME_SEP}ctrl+k${CHROME_SEP}esc`;
const CHOICE_HINT = `type filter${CHROME_SEP}up/down move${CHROME_SEP}enter select${CHROME_SEP}esc back`;
const CUSTOM_CHOICE_HINT = `type filter${CHROME_SEP}up/down${CHROME_SEP}enter select/custom${CHROME_SEP}esc back`;
const RUN_HINT = `esc dismiss${CHROME_SEP}run continues`;
const FAIL_HINT = "enter/esc close";

/** Every chrome fragment the picker draws; each glyph must be unambiguous single-column. */
export const PICKER_CHROME_STRINGS: readonly string[] = [
  LIST_HINT,
  EMPTY_LIST_HINT,
  PALETTE_HINT,
  DELETE_CONFIRM_HINT,
  CHOICE_HINT,
  CUSTOM_CHOICE_HINT,
  RUN_HINT,
  FAIL_HINT,
  CUSTOM_CHOICE_LABEL,
  ELLIPSIS,
  CHROME_SEP,
  "> ",
  "! ",
  "filter workflows...",
  "filter runs...",
  "prompt...",
  `enter submit${CHROME_SEP}esc back`,
  EMPTY_CATALOG_MESSAGE,
];

function updateDetail(state: PickerState): void {
  if (state.mode !== "list") {
    state.chrome.setDetail("");
    return;
  }
  if (!hasVisibleEntries(state.entries)) {
    state.chrome.setDetail(formatDetailLines(EMPTY_CATALOG_MESSAGE, state.contentWidth));
    return;
  }
  if (state.chrome.options().length === 0) {
    const needle = state.chrome.filterValue().trim() || "…";
    state.chrome.setDetail(
      formatDetailLines(`No workflows matching ${needle}`, state.contentWidth),
    );
    return;
  }
  const option = state.chrome.options()[state.chrome.selectedIndex()];
  state.chrome.setDetail(formatDetailLines(option?.description ?? "", state.contentWidth));
}

function updateListFooter(state: PickerState): void {
  if (state.mode !== "list") return;
  const hint = hasVisibleEntries(state.entries) ? LIST_HINT : EMPTY_LIST_HINT;
  state.chrome.setFooter(
    formatListFooter(
      state.contentWidth,
      state.chrome.selectedIndex(),
      state.chrome.options().length,
      hint,
    ),
  );
}

function applyRowSelectionPrefixes(state: PickerState): void {
  if (state.mode !== "list") return;
  const selectedIndex = state.chrome.selectedIndex();
  state.chrome.setOptions(
    state.chrome.options().map((opt, i) => {
      const value = opt.value as PickerRowValue | undefined;
      if (!value?.entry) return opt;
      const entry = value.entry;
      return {
        ...opt,
        name: formatPickerRowName(
          workflowDisplayTitle(entry.name, entry.title),
          entry.error ? "invalid" : entry.source === "repo" ? "repo" : "global",
          entrySensitivity(entry).length > 0,
          state.contentWidth,
          i === selectedIndex,
        ),
      };
    }),
  );
}

function refreshListChrome(state: PickerState): void {
  applyRowSelectionPrefixes(state);
  updateDetail(state);
  updateListFooter(state);
}

function applyFilter(state: PickerState): void {
  const { valid, invalid } = filterWorkflowEntries(state.entries, state.chrome.filterValue());
  state.chrome.setOptions([
    ...buildPickerOptions(valid, state.contentWidth),
    ...buildInvalidOptions(invalid, state.contentWidth),
  ]);
  refreshListChrome(state);
}

function applyChoiceFilter(state: PickerState): void {
  const matched = filterChoiceOptions(state.choiceOptions, state.chrome.filterValue());
  const options: SelectOption[] = matched.map((option) => ({
    name: option,
    description: "",
    value: option,
  }));
  if (state.customChoice) {
    options.push({
      name: CUSTOM_CHOICE_LABEL,
      description: "",
      value: CUSTOM_CHOICE_VALUE as unknown as string,
    });
  }
  state.chrome.setOptions(options);
}

function showWorkflowBrowser(state: PickerState): void {
  state.chrome.showBrowser({
    filterPlaceholder: "filter workflows...",
    filterValue: "",
    showFilter: hasVisibleEntries(state.entries),
  });
  refreshUpdateHint(state);
}

function refreshUpdateHint(state: PickerState): void {
  if (state.mode !== "list" || !state.newerReleaseVersion) {
    state.chrome.updateHint(undefined);
    return;
  }
  const hint = formatFilterUpdateHint(state.contentWidth);
  state.chrome.updateHint(hint ? ` ${hint}` : undefined);
}

function showStatus(
  state: PickerState,
  content: string,
  options: { flexGrow?: number; warn?: boolean } = {},
): void {
  state.chrome.status(content, options);
}

function focusTextField(state: PickerState, placeholder: string, value: string): void {
  state.chrome.focusPrompt(placeholder, value);
  state.chrome.setFooter(`enter submit${CHROME_SEP}esc back`);
}

function saveWorkflowListChrome(state: PickerState): void {
  state.savedWorkflowFilter = state.chrome.filterValue();
  state.savedListEntry = selectedListEntry(state);
}

function restoreWorkflowListSelection(state: PickerState): void {
  const saved = state.savedListEntry;
  if (!saved || state.chrome.options().length === 0) return;
  const idx = state.chrome.options().findIndex((option) => {
    const value = option.value as PickerRowValue | undefined;
    return value?.entry.name === saved.name && value?.entry.source === saved.source;
  });
  if (idx >= 0) state.chrome.setSelectedIndex(idx);
}

/** Return to the workflow list; restores filter/selection saved before palette or runs. */
export function setListMode(state: PickerState): void {
  state.runs.leave();
  state.mode = "list";
  state.pending = undefined;
  state.deleteTarget = undefined;
  state.deleteInFlight = false;
  state.workflow = undefined;
  state.inputQueue = [];
  state.inputSession?.cancelPending();
  state.inputSession = undefined;
  syncInputSession(state);
  state.choiceOptions = [];
  state.customChoice = false;
  state.progressLines = [];
  showWorkflowBrowser(state);
  state.chrome.showList(formatRule(state.contentWidth));
  state.chrome.setPromptValue("");
  state.chrome.clearStatus();
  state.chrome.setFilterValue(state.savedWorkflowFilter);
  applyFilter(state);
  restoreWorkflowListSelection(state);
  refreshListChrome(state);
  if (state.chrome.filterVisible()) state.chrome.focusFilter();
  else state.chrome.focusList();
}

/** Attach a runs browser bound to this picker's chrome. Call after UI fields exist. */
export function attachRunsBrowser(state: PickerState): RunsBrowser {
  return (state.runs = createRunsBrowser({
    repoRoot: state.repoRoot,
    getContentWidth: () => state.contentWidth,
    chrome: state.chrome,
    launchWorkbenchRoute: (route) => launchWorkbenchRoute(state, route),
  }));
}

function launchFromPicker(state: PickerState, entry: WorkflowListEntry): Promise<void> {
  return state.runs.startRun(entry, {
    ctx: state.ctx,
    config: state.config,
    inputValues: state.inputValues,
    inputDomains: state.inputDomains,
    workflow: state.workflow,
    loadWorkflow: state.loadWorkflow,
    launchRun: state.launchRun,
    getExit: () => state.exit,
  });
}

/**
 * What the prompt is collecting, then how to answer it. The description carries the author's
 * intent; without one the type and domain still say more than a bare name.
 */
export function formatInputPrompt(spec: InputSpec): string {
  const desc = spec.description?.trim();
  const label = desc ? `${spec.name} — ${desc}` : spec.name;
  const hints: string[] = [];
  if (spec.type === "text") {
    hints.push("type free text");
    if (spec.default) hints.push(`default ${spec.default}`);
  } else {
    const count = spec.options?.length;
    hints.push(count === undefined ? "pick one" : `pick one of ${count}`);
    if (spec.allowCustom) hints.push("or type your own");
  }
  if (spec.minLength !== undefined && spec.minLength > 0) {
    hints.push(`min ${spec.minLength} char${spec.minLength === 1 ? "" : "s"}`);
  }
  return `${label}${CHROME_SEP}${hints.join(CHROME_SEP)}`;
}

/** Answers already collected, so a filtered domain is not a mystery. */
export function formatInputAnswers(
  queue: InputSpec[],
  values: Record<string, string>,
  contentWidth: number,
): string {
  const answered = queue
    .filter((spec) => Object.hasOwn(values, spec.name))
    .map((spec) => `${spec.name}=${values[spec.name]}`);
  if (answered.length === 0) return "";
  return truncate(`chosen: ${answered.join(CHROME_SEP)}`, contentWidth);
}

function inputStatusLine(
  entry: WorkflowListEntry,
  spec: InputSpec,
  ordinal: number,
  answers: string,
): string {
  const title = workflowDisplayTitle(entry.name, entry.title);
  const head = `${title}${CHROME_SEP}${entry.source}${CHROME_SEP}input ${ordinal}`;
  const lines = [head, formatInputPrompt(spec)];
  if (answers) lines.push(answers);
  return lines.join("\n");
}

function setInputMode(
  state: PickerState,
  entry: WorkflowListEntry,
  spec: InputSpec,
  options?: string[],
): void {
  const resolvedOptions = options ?? spec.options;
  if ((spec.type === "choice" || spec.type === "profile") && (resolvedOptions?.length ?? 0) === 0) {
    showFailure(
      state,
      entry,
      new Error(
        spec.type === "profile"
          ? `input '${spec.name}': no profiles configured; run \`hwf init\` or \`hwf init --global\``
          : `input '${spec.name}': choice produced no options`,
      ),
    );
    return;
  }
  state.mode = "input";
  state.pending = entry;
  state.customChoice = spec.allowCustom === true;
  state.chrome.hideList();
  const answered = state.inputQueue.filter(
    (other) => other.name !== spec.name && Object.hasOwn(state.inputValues, other.name),
  );
  showStatus(
    state,
    inputStatusLine(
      entry,
      spec,
      answered.length + 1,
      formatInputAnswers(answered, state.inputValues, state.contentWidth),
    ),
  );
  const hasAnswer = Object.hasOwn(state.inputValues, spec.name);
  const restored = hasAnswer ? state.inputValues[spec.name]! : undefined;
  if (spec.type === "choice" || spec.type === "profile") {
    state.choiceOptions = resolvedOptions ?? [];
    if (
      shouldRestoreCustomChoiceText(hasAnswer, restored, state.choiceOptions, state.customChoice)
    ) {
      showCustomChoiceText(state, spec, restored ?? "");
      return;
    }
    state.chrome.showBrowser({
      filterPlaceholder: "filter workflows...",
      filterValue: "",
      showFilter: hasVisibleEntries(state.entries),
    });
    applyChoiceFilter(state);
    const preselect = hasAnswer
      ? state.chrome.options().findIndex((o) => o.value === restored)
      : spec.default
        ? state.chrome.options().findIndex((o) => o.value === spec.default)
        : 0;
    state.chrome.setSelectedIndex(Math.max(preselect, 0));
    state.chrome.setFooter(state.customChoice ? CUSTOM_CHOICE_HINT : CHOICE_HINT);
    state.chrome.focusFilter();
    return;
  }
  state.customChoice = false;
  showCustomChoiceText(state, spec, restored ?? spec.default ?? "");
}

function showCustomChoiceText(state: PickerState, spec: InputSpec, value: string): void {
  state.choiceOptions = [];
  state.chrome.hideBrowser();
  focusTextField(state, `${spec.name}...`, value);
}

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  state.chrome.hideBrowser();
  state.chrome.hideList();
  showStatus(state, formatRunProgress(entry.name, []), { flexGrow: 1 });
  state.chrome.setFooter(RUN_HINT);
}

function finish(state: PickerState, code: number): void {
  state.inputSession?.cancelPending();
  state.runs.dispose();
  state.exit = { code };
  state.chrome.destroy();
}

function navigateSelectList(state: PickerState, key: KeyEvent): boolean {
  if (key.name === "up") {
    key.preventDefault();
    state.chrome.moveUp();
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    state.chrome.moveDown();
    return true;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    state.chrome.selectCurrent();
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
    finish(state, pickerEscapeExitCode(state.mode, state.running));
    return;
  }
  if (state.running) return;
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    finish(state, 1);
  }
}

/** Escape while a run is in flight dismisses with 0; Escape after failure is nonzero. */
export function pickerEscapeExitCode(mode: PickerState["mode"], running: boolean): number {
  if (mode === "run") return running ? 0 : 1;
  return 0;
}

/** Selected valid row in list mode, or undefined when the filtered list is empty. */
export function selectedListEntry(state: PickerState): WorkflowListEntry | undefined {
  if (state.chrome.options().length === 0) return undefined;
  const option = state.chrome.options()[state.chrome.selectedIndex()];
  const value = option?.value as PickerRowValue | undefined;
  return value?.entry;
}

export function launchWorkbenchRoute(state: PickerState, route: string): void {
  const parsed = parseWebRoute(route);
  if (!parsed) return;
  const launch = state.launchWeb ?? launchDetachedWeb;
  try {
    launch({ route: parsed.hash, repoRoot: state.repoRoot });
  } catch (error) {
    const detail = truncate(error instanceof Error ? error.message : String(error), 60);
    showStatus(state, `workbench failed${CHROME_SEP}${detail}`);
    updateListFooter(state);
    return;
  }
  finish(state, 0);
}

function openActionsPalette(state: PickerState): void {
  saveWorkflowListChrome(state);
  state.mode = "palette";
  state.deleteTarget = undefined;
  state.deleteInFlight = false;
  state.chrome.hideBrowser();
  state.chrome.hideList();
  showStatus(state, formatPaletteBody(selectedListEntry(state)), { flexGrow: 1 });
  state.chrome.setFooter(PALETTE_HINT);
}

function openDeleteConfirm(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "delete-confirm";
  state.deleteTarget = entry;
  state.deleteInFlight = false;
  state.chrome.hideBrowser();
  state.chrome.hideList();
  showStatus(state, `Delete ${entry.name} (${entry.source})?\ny  yes, delete\nn  no`, {
    flexGrow: 1,
  });
  state.chrome.setFooter(DELETE_CONFIRM_HINT);
}

/** Claim the confirmed delete target; a second call while in flight returns undefined. */
export function beginConfirmedDelete(state: {
  deleteTarget?: WorkflowListEntry;
  deleteInFlight?: boolean;
}): WorkflowListEntry | undefined {
  if (state.deleteInFlight) return undefined;
  const entry = state.deleteTarget;
  if (!entry) return undefined;
  state.deleteTarget = undefined;
  state.deleteInFlight = true;
  return entry;
}

function failPalette(state: PickerState, label: string, error: unknown): void {
  const detail = truncate(error instanceof Error ? error.message : String(error), 60);
  showStatus(state, `${label}${CHROME_SEP}${detail}`);
  state.chrome.setFooter(PALETTE_HINT);
}

async function runPaletteAction(state: PickerState, action: ResolvedPaletteAction): Promise<void> {
  if (action.id === "new" || action.id === "import" || action.id === "open") {
    launchWorkbenchRoute(state, action.route);
    return;
  }
  if (action.id === "examples") {
    try {
      await openExamplesInBrowser();
    } catch (error) {
      failPalette(state, "examples failed", error);
      return;
    }
    setListMode(state);
    return;
  }
  if (action.id === "share") {
    try {
      await shareWorkflowCopy({ entry: action.entry, repoRoot: state.repoRoot });
    } catch (error) {
      failPalette(state, "share failed", error);
      return;
    }
    setListMode(state);
    return;
  }
  if (action.id === "delete") openDeleteConfirm(state, action.entry);
}

function handlePaletteKey(state: PickerState, key: KeyEvent): void {
  if (key.name === "escape") {
    key.preventDefault();
    setListMode(state);
    return;
  }
  if (key.ctrl || key.meta || key.sequence.length !== 1) return;
  const letter = key.sequence.toLowerCase();
  const action = resolvePaletteLetter(letter, selectedListEntry(state));
  if (!action) return;
  key.preventDefault();
  void runPaletteAction(state, action);
}

function handleDeleteConfirmKey(state: PickerState, key: KeyEvent): void {
  if (state.deleteInFlight) {
    key.preventDefault();
    return;
  }
  if (key.name === "escape" || (key.sequence.length === 1 && key.sequence.toLowerCase() === "n")) {
    key.preventDefault();
    openActionsPalette(state);
    return;
  }
  if (!(key.sequence.length === 1 && key.sequence.toLowerCase() === "y")) return;
  key.preventDefault();
  const entry = beginConfirmedDelete(state);
  if (!entry) return;
  showStatus(state, `Deleting ${entry.name}…`, { flexGrow: 1 });
  state.chrome.setFooter(DELETE_CONFIRM_HINT);
  void (async () => {
    try {
      await deleteWorkflowFile(entry);
      state.entries = await state.reloadEntries();
      setListMode(state);
    } catch (error) {
      state.deleteInFlight = false;
      const detail = truncate(error instanceof Error ? error.message : String(error), 60);
      setListMode(state);
      showStatus(state, `delete failed${CHROME_SEP}${detail}`);
      updateListFooter(state);
    }
  })();
}

export function tryOpenActionsPalette(state: PickerState, key: KeyEvent): boolean {
  if (state.mode !== "list") return false;
  if (!key.ctrl || key.name.toLowerCase() !== "k") return false;
  key.preventDefault();
  openActionsPalette(state);
  return true;
}

function backtrackInput(state: PickerState): void {
  const entry = state.pending;
  const session = state.inputSession;
  if (!entry || !session) {
    setListMode(state);
    return;
  }
  if (!session.back()) {
    setListMode(state);
    return;
  }
  syncInputSession(state);
  void advanceInput(state, entry);
}

function handlePickerKey(state: PickerState, key: KeyEvent): void {
  if (state.mode === "run" && !state.runs.isActive()) return handleRunKey(state, key);
  if (state.runs.isActive()) {
    if (state.runs.handleKey(key)) return;
    if (key.name === "escape") {
      key.preventDefault();
      finish(state, 0);
      return;
    }
    if (key.name === "tab" && !key.ctrl && !key.meta) {
      key.preventDefault();
      setListMode(state);
    }
    return;
  }
  if (state.mode === "palette") return handlePaletteKey(state, key);
  if (state.mode === "delete-confirm") return handleDeleteConfirmKey(state, key);
  if (key.name === "escape") {
    key.preventDefault();
    if (state.mode === "list") finish(state, 0);
    else if (state.mode === "input") backtrackInput(state);
    else setListMode(state);
    return;
  }
  if (state.mode === "list" && key.name === "tab" && !key.ctrl && !key.meta) {
    key.preventDefault();
    saveWorkflowListChrome(state);
    state.pending = undefined;
    state.workflow = undefined;
    void state.runs.enter();
    return;
  }
  if (state.mode === "input") return handleInputKey(state, key);
  if (tryOpenActionsPalette(state, key)) return;
  navigateSelectList(state, key);
}

/**
 * True when a raw stdin sequence should be dropped as a herdr prefix-key leak.
 * Keeps tab/newline/CR/escape, Ctrl+K (0x0b), and Ctrl+G (0x07) for OpenTUI.
 */
export function shouldDropStdinLeakSequence(sequence: string): boolean {
  if (sequence.length !== 1) return false;
  const c = sequence.charCodeAt(0);
  if (c >= 0x20) return false;
  if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b || c === 0x0b || c === 0x07) {
    return false;
  }
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
  showStatus(
    state,
    formatRunProgress(entry.name, state.progressLines, {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }),
    { flexGrow: 1 },
  );
  state.chrome.setFooter(FAIL_HINT);
}

/** Declared inputs first, then run. Skips inactive inputs under collected answers. */
async function advanceInput(state: PickerState, entry: WorkflowListEntry): Promise<void> {
  const session = state.inputSession;
  if (!session) {
    void launchFromPicker(state, entry);
    return;
  }
  state.mode = "input";
  const cur = await session.current();
  syncInputSession(state);
  if (cur.status === "cancelled") return;
  if (cur.status === "error") {
    showFailure(state, entry, new Error(cur.error));
    return;
  }
  if (cur.status === "done") {
    void launchFromPicker(state, entry);
    return;
  }
  setInputMode(state, entry, cur.prompt.spec, cur.prompt.options);
}

function storeInput(state: PickerState, value: string): void {
  const entry = state.pending;
  const session = state.inputSession;
  if (!entry || !session) return;
  const answered = session.answer(value);
  if (!answered.ok) {
    showStatus(state, answered.error, { warn: true });
    return;
  }
  syncInputSession(state);
  void advanceInput(state, entry);
}

function submitInputChoice(state: PickerState, value: unknown): void {
  if (state.mode !== "input") return;
  if (isCustomChoiceValue(value)) {
    const spec = state.inputQueue[state.inputIndex];
    if (!spec) return;
    showCustomChoiceText(state, spec, state.inputValues[spec.name] ?? spec.default ?? "");
    return;
  }
  if (typeof value !== "string") return;
  storeInput(state, value);
}

function submitInputText(state: PickerState, value: string): void {
  if (state.mode === "input") storeInput(state, value.trim());
}

export function acceptWorkflow(state: PickerState, entry: WorkflowListEntry): void {
  if (entry.error) {
    const err = stripFilePrefix(entry.error, entry.file);
    state.chrome.setDetail(formatDetailLines(err, state.contentWidth));
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
    state.inputSession = createInputSession({
      specs: state.inputQueue,
      file: entry.file,
      config: state.config,
      repoRoot: state.repoRoot,
    });
    syncInputSession(state);
    state.running = false;
    if (flags.length > 0) {
      showStatus(
        state,
        `${workflowDisplayTitle(entry.name, entry.title)}${CHROME_SEP}${entry.source}${CHROME_SEP}${flags.join(CHROME_SEP)}`,
        { warn: true },
      );
    }
    void advanceInput(state, entry);
  } catch (error) {
    showFailure(state, entry, error);
  }
}

function bindPickerEvents(state: PickerState): void {
  state.chrome.on("list-select", (option) => {
    if (state.mode === "input") {
      if (typeof option.value === "string" || isCustomChoiceValue(option.value)) {
        submitInputChoice(state, option.value);
      }
      return;
    }
    if (state.runs.isActive()) {
      state.runs.openSelected();
      return;
    }
    if (state.mode !== "list") return;
    const value = option.value as PickerRowValue | undefined;
    if (!value) return;
    acceptWorkflow(state, value.entry);
  });
  state.chrome.on("list-selection-changed", () => {
    if (state.runs.isActive()) state.runs.onSelectionChanged();
    else if (state.mode === "list") refreshListChrome(state);
  });
  state.chrome.on("filter-input", () => {
    if (state.runs.isActive()) state.runs.onFilterInput();
    else if (state.mode === "list") applyFilter(state);
    else if (state.mode === "input" && state.choiceOptions.length > 0) applyChoiceFilter(state);
  });
  state.chrome.on("prompt-enter", (value) => submitInputText(state, value));
  state.chrome.on("keypress", (key) => handlePickerKey(state, key));
  state.chrome.on("resize", (width) => {
    state.contentWidth = pickerContentWidth(width);
    state.chrome.setRule(formatRule(state.contentWidth));
    if (state.mode === "list" && !state.runs.isActive()) {
      applyFilter(state);
      refreshUpdateHint(state);
    } else {
      state.runs.onResize();
    }
  });
}

export type PickerSessionOpts = {
  entries: WorkflowListEntry[];
  repoRoot: string;
  config: WorkflowsConfig;
  ctx: InvocationContext;
  /** Override for tests — defaults to GitHub latest-release fetch. */
  checkLatestRelease?: () => Promise<{ version: string } | null>;
  embeddedVersion?: string;
  chdir?: (path: string) => void;
};

export async function runPickerSession(opts: PickerSessionOpts): Promise<number> {
  (opts.chdir ?? ((p) => process.chdir(p)))(opts.repoRoot);

  const leak = stdinLeakHandlers();
  leak.drain();

  // Start before mount; never await — buffer if the check wins the race.
  let pendingNewer: string | undefined;
  let applyNewer: ((version: string) => void) | undefined;
  startPickerUpdateCheck({
    check: opts.checkLatestRelease ?? defaultPickerReleaseCheck,
    embeddedVersion: opts.embeddedVersion ?? embeddedPluginVersion(),
    onNewer: (version) => {
      if (applyNewer) applyNewer(version);
      else pendingNewer = version;
    },
  });

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    prependInputHandlers: leak.prepend,
  });
  const theme = await resolveHostTheme(renderer);
  const chrome = mountPickerChrome(renderer, theme, LIST_HINT);

  const state = {
    mode: "list" as const,
    entries: opts.entries,
    inputQueue: [] as InputSpec[],
    inputIndex: 0,
    inputValues: {} as Record<string, string>,
    inputDomains: {} as Record<string, string[]>,
    choiceOptions: [] as string[],
    customChoice: false,
    running: false,
    progressLines: [] as string[],
    repoRoot: opts.repoRoot,
    config: opts.config,
    ctx: opts.ctx,
    loadWorkflow: loadWorkflowEntry,
    reloadEntries: async () => {
      const config = await loadConfig(opts.repoRoot);
      state.config = config;
      return listWorkflows(opts.repoRoot, config);
    },
    contentWidth: pickerContentWidth(renderer.width),
    theme,
    chrome,
    savedWorkflowFilter: "",
  } as PickerState;
  attachRunsBrowser(state);

  applyNewer = (version) => {
    state.newerReleaseVersion = version;
    refreshUpdateHint(state);
  };
  if (pendingNewer) applyNewer(pendingNewer);

  bindPickerEvents(state);
  setListMode(state);

  await new Promise<void>((resolve) => {
    chrome.whenDestroyed(() => resolve());
  });

  return state.exit?.code ?? 0;
}
