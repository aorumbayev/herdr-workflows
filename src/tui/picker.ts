import type { InvocationContext, WorkflowsConfig } from "../config";
import { loadContext } from "../config";
import { openInBrowser } from "../console";
import { EXAMPLES_URL, PRODUCT_VERSION } from "../version";
import {
  analyzeResolvedSensitivity,
  listWorkflows,
  loadWorkflowEntry,
  workflowDisplayTitle,
} from "../workflow/load";
import { createInputSession, type InputSession } from "../workflow/inputs";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { parseWebRoute } from "../web/endpoint";
import {
  beginConfirmedDelete,
  deleteWorkflowFile,
  EMPTY_CATALOG_MESSAGE,
  EMPTY_LIST_HINT,
  formatPaletteBody,
  PALETTE_HINT,
  DELETE_CONFIRM_HINT,
  pickerEscapeExitCode,
  resolvePaletteLetter,
  shareWorkflowCopy,
  shouldDropStdinLeakSequence,
  type ResolvedPaletteAction,
} from "./picker-actions";
import {
  mountChrome,
  type ChromeKeyEvent,
  type ChromeOption,
  type PickerChrome,
} from "./picker-chrome";
import {
  CHROME_SEP,
  CHOICE_HINT,
  CUSTOM_CHOICE_HINT,
  CUSTOM_CHOICE_LABEL,
  FAIL_HINT,
  LIST_HINT,
  RUN_HINT,
  buildInvalidOptions,
  buildPickerOptions,
  entrySensitivity,
  filterChoiceOptions,
  filterWorkflowEntries,
  formatDetailLines,
  formatInputAnswers,
  formatInputPrompt,
  formatListFooter,
  formatPickerRowName,
  formatRule,
  formatRunProgress,
  hasVisibleEntries,
  isCustomChoiceValue,
  selectedListEntry,
  shouldRestoreCustomChoiceText,
  stripFilePrefix,
  truncate,
  type CustomChoiceValue,
} from "./picker-rows";
import { createRunsBrowser, type RunsBrowser } from "./runs-browser";
import {
  launchDetachedWeb,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "../run/launch";
import type { HostTheme } from "./picker-chrome";
import {
  defaultPickerReleaseCheck,
  formatFilterUpdateHint,
  startPickerUpdateCheck,
} from "./update-indicator";

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

const CUSTOM_CHOICE_VALUE: CustomChoiceValue = { kind: "custom" };

function pickerContentWidth(rendererWidth: number): number {
  return Math.max(0, rendererWidth - 2);
}

type PickerRowValue = { entry: WorkflowListEntry };

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
  const options: ChromeOption[] = matched.map((option) => ({
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
function setListMode(state: PickerState): void {
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
function attachRunsBrowser(state: PickerState): RunsBrowser {
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

function navigateSelectList(state: PickerState, key: ChromeKeyEvent): boolean {
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

function handleInputKey(state: PickerState, key: ChromeKeyEvent): void {
  const spec = state.inputQueue[state.inputIndex];
  if (!spec || (spec.type !== "choice" && spec.type !== "profile")) return;
  navigateSelectList(state, key);
}

function handleRunKey(state: PickerState, key: ChromeKeyEvent): void {
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

function launchWorkbenchRoute(state: PickerState, route: string): void {
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
      await openInBrowser(EXAMPLES_URL);
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

function handlePaletteKey(state: PickerState, key: ChromeKeyEvent): void {
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

function handleDeleteConfirmKey(state: PickerState, key: ChromeKeyEvent): void {
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

function tryOpenActionsPalette(state: PickerState, key: ChromeKeyEvent): boolean {
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

function handlePickerKey(state: PickerState, key: ChromeKeyEvent): void {
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

function acceptWorkflow(state: PickerState, entry: WorkflowListEntry): void {
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
    embeddedVersion: opts.embeddedVersion ?? PRODUCT_VERSION,
    onNewer: (version) => {
      if (applyNewer) applyNewer(version);
      else pendingNewer = version;
    },
  });

  const mounted = await mountChrome({
    listHint: LIST_HINT,
    exitOnCtrlC: true,
    prependInputHandlers: leak.prepend,
  });
  const { chrome, theme } = mounted;

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
      const app = await loadContext({ repoRoot: opts.repoRoot });
      state.config = app.config;
      return listWorkflows(opts.repoRoot, app.config);
    },
    contentWidth: pickerContentWidth(mounted.width),
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

/** Declared internal seam — unit tests drive state transitions without the TTY entry. */
export const pickerSeams = {
  setListMode,
  attachRunsBrowser,
  launchWorkbenchRoute,
  tryOpenActionsPalette,
  acceptWorkflow,
};
