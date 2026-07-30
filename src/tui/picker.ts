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
import { profileNames } from "../config";
import { loadConfig } from "../config";
import { sanitizeDisplay } from "../herdr";
import { listWorkflows, loadWorkflowEntry, resolveDynamicChoices } from "../workflow/load";
import { nextActiveInput } from "../workflow/inputs";
import {
  analyzeResolvedSensitivity,
  sensitivityLabels,
  workflowDisplayTitle,
} from "../workflow/trust";
import type { InputSpec, LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { parseWebRoute } from "../web/route";
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
import {
  launchDetachedRun,
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
  leaveManagedCheckout,
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

/** Apply async dynamic/profile options only when the resolve generation still matches. */
export function commitResolvedOptions(
  state: { resolveGeneration: number; inputDomains: Record<string, string[]> },
  startedGeneration: number,
  name: string,
  options: string[],
): boolean {
  if (startedGeneration !== state.resolveGeneration) return false;
  state.inputDomains[name] = options;
  return true;
}

const CUSTOM_CHOICE_LABEL = "custom...";
const CUSTOM_CHOICE_VALUE: CustomChoiceValue = { kind: "custom" };
const ELLIPSIS = "...";
const CHROME_SEP = " | ";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function columns(text: string): number {
  return Bun.stringWidth(text);
}

function padColumns(text: string, width: number): string {
  const used = columns(text);
  if (used >= width) return text;
  return `${text}${" ".repeat(width - used)}`;
}

function takeColumns(text: string, max: number): string {
  if (max <= 0) return "";
  if (columns(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = columns(segment);
    if (used + w > max) break;
    out += segment;
    used += w;
  }
  return out;
}

function stripFilePrefix(error: string, file: string): string {
  return error.startsWith(file) ? error.slice(file.length).replace(/^[,:]\s*/, "") : error;
}

/** Truncate to `max` terminal columns at a grapheme boundary. */
export function truncate(text: string, max: number): string {
  if (columns(text) <= max) return text;
  if (max <= 0) return "";
  const ellipsisCols = columns(ELLIPSIS);
  if (max < ellipsisCols) return takeColumns(ELLIPSIS, max);
  return `${takeColumns(text, max - ellipsisCols)}${ELLIPSIS}`;
}

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

export function entrySensitivity(entry: WorkflowListEntry): string[] {
  return sensitivityLabels({
    hasCommands: entry.hasCommands === true,
    hasTranscript: entry.needsTranscript === true,
    sensitiveMethods: entry.sensitiveMethods ?? [],
    unresolvedChildren: entry.unresolvedChildren ?? [],
  });
}

// SelectRenderable draws name at contentX+1+indicatorWidth; indicator off → pad 1 only.
const SELECT_NAME_OFFSET = 1;
const CURSOR_PREFIX_WIDTH = 2;
const ROW_TEXT_INDENT = SELECT_NAME_OFFSET + CURSOR_PREFIX_WIDTH;
const LOCATION_WIDTH = 7;
const WARNING_WIDTH = 2;

export function formatPickerRowName(
  title: string,
  location: "global" | "repo" | "invalid",
  warned: boolean,
  rowWidth: number,
  selected = false,
): string {
  const titleW = Math.max(
    0,
    rowWidth - SELECT_NAME_OFFSET - CURSOR_PREFIX_WIDTH - 1 - WARNING_WIDTH - LOCATION_WIDTH,
  );
  const prefix = selected ? "> " : "  ";
  const warning = warned ? "! " : "  ";
  return `${prefix}${padColumns(truncate(title, titleW), titleW)} ${warning}${location.padStart(LOCATION_WIDTH)}`;
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

export function buildInvalidOptions(
  invalid: WorkflowListEntry[],
  rowWidth: number,
): SelectOption[] {
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
  const body = lines.length > 0 ? lines.join("\n") : ELLIPSIS;
  if (!terminal) return `${name}\n${body}`;
  const status = terminal.ok ? "Done." : `Failed${CHROME_SEP}${terminal.detail}`;
  return `${name}\n${body}\n\n${status}`;
}

export function filterChoiceOptions(options: string[], filter: string): string[] {
  return filter ? options.filter((option) => option.includes(filter)) : options;
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
  /** Bumped on Escape/backtrack so late async option resolves are ignored. */
  resolveGeneration: number;
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
  runHandle?: DetachedRunHandle;
  workflow?: LoadedWorkflow;
  contentWidth: number;
  theme: HostTheme;
  renderer: CliRenderer;
  filterRow: BoxRenderable;
  filter: InputRenderable;
  updateHint: TextRenderable;
  listBlock: BoxRenderable;
  list: SelectRenderable;
  status: TextRenderable;
  detail: TextRenderable;
  rule: TextRenderable;
  promptInput: InputRenderable;
  footer: TextRenderable;
  /** Set when a newer published release is known; drives list-mode filter-row hint. */
  newerReleaseVersion?: string;
};

export const LIST_HINT = `enter run${CHROME_SEP}ctrl+k${CHROME_SEP}esc`;
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
  "filter...",
  "prompt...",
  `enter submit${CHROME_SEP}esc back`,
  EMPTY_CATALOG_MESSAGE,
];

export function formatRule(contentWidth: number): string {
  const field = Math.max(0, contentWidth - ROW_TEXT_INDENT);
  return `${" ".repeat(ROW_TEXT_INDENT)}${"-".repeat(field)}`;
}

export function formatListFooter(
  contentWidth: number,
  selectedIndex: number,
  total: number,
  hint: string,
): string {
  if (total === 0) return truncate(hint, contentWidth);
  const counter = `${selectedIndex + 1}/${total}`;
  const hintCols = columns(hint);
  const counterCols = columns(counter);
  if (hintCols + 1 + counterCols <= contentWidth) {
    const pad = contentWidth - hintCols - counterCols;
    return `${hint}${" ".repeat(pad)}${counter}`;
  }
  const clipped = truncate(hint, Math.max(0, contentWidth - counterCols - 1));
  const pad = Math.max(0, contentWidth - columns(clipped) - counterCols);
  return `${clipped}${" ".repeat(pad)}${counter}`;
}

function takeWrappedLine(text: string, budget: number): string {
  if (columns(text) <= budget) return text;
  const window = takeColumns(text, budget);
  const space = window.lastIndexOf(" ");
  if (space > 0) return window.slice(0, space);
  return window;
}

export function formatDetailLines(description: string, contentWidth: number): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const indent = " ".repeat(ROW_TEXT_INDENT);
  const budget = Math.max(0, contentWidth - ROW_TEXT_INDENT);
  const line1 = takeWrappedLine(text, budget);
  const rest = text.slice(line1.length).trimStart();
  if (!rest) return `${indent}${line1}`;
  const line2 = columns(rest) <= budget ? rest : truncate(rest, budget);
  return `${indent}${line1}\n${indent}${line2}`;
}

function updateDetail(state: PickerState): void {
  if (state.mode !== "list") {
    state.detail.content = "";
    return;
  }
  if (!hasVisibleEntries(state.entries)) {
    state.detail.content = formatDetailLines(EMPTY_CATALOG_MESSAGE, state.contentWidth);
    return;
  }
  if (state.list.options.length === 0) {
    const needle = state.filter.value.trim() || "…";
    state.detail.content = formatDetailLines(`No workflows matching ${needle}`, state.contentWidth);
    return;
  }
  const option = state.list.options[state.list.getSelectedIndex()];
  state.detail.content = formatDetailLines(option?.description ?? "", state.contentWidth);
}

function updateListFooter(state: PickerState): void {
  if (state.mode !== "list") return;
  const hint = hasVisibleEntries(state.entries) ? LIST_HINT : EMPTY_LIST_HINT;
  state.footer.content = formatListFooter(
    state.contentWidth,
    state.list.getSelectedIndex(),
    state.list.options.length,
    hint,
  );
}

function applyRowSelectionPrefixes(state: PickerState): void {
  if (state.mode !== "list") return;
  const selectedIndex = state.list.getSelectedIndex();
  state.list.options = state.list.options.map((opt, i) => {
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
  });
}

function refreshListChrome(state: PickerState): void {
  applyRowSelectionPrefixes(state);
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
  const options = matched.map((option) => ({
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
  setListOptions(state, options);
}

function hideBrowserChrome(state: PickerState): void {
  state.filterRow.visible = false;
  state.listBlock.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  state.detail.visible = false;
  state.rule.visible = false;
  state.promptInput.visible = false;
  hideUpdateHint(state);
}

function showBrowserChrome(state: PickerState): void {
  state.promptInput.visible = false;
  const showFilter = hasVisibleEntries(state.entries);
  state.filterRow.visible = showFilter;
  state.filter.visible = showFilter;
  state.filter.placeholder = "filter...";
  state.filter.value = "";
  state.listBlock.visible = true;
  state.list.visible = true;
  state.list.flexGrow = 0;
  state.list.height = 6;
  refreshUpdateHint(state);
}

function hideUpdateHint(state: PickerState): void {
  state.updateHint.visible = false;
  state.updateHint.content = "";
}

function refreshUpdateHint(state: PickerState): void {
  if (state.mode !== "list" || !state.newerReleaseVersion) {
    hideUpdateHint(state);
    return;
  }
  const hint = formatFilterUpdateHint(state.contentWidth);
  if (!hint) {
    hideUpdateHint(state);
    return;
  }
  state.updateHint.content = ` ${hint}`;
  state.updateHint.visible = true;
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

function showStatus(
  state: PickerState,
  content: string,
  options: { flexGrow?: number; warn?: boolean } = {},
): void {
  state.status.visible = true;
  state.status.flexGrow = options.flexGrow ?? 0;
  state.status.fg = options.warn ? state.theme.warn : state.theme.text.fg;
  state.status.attributes = TextAttributes.NONE;
  state.status.content = content;
}

function focusTextField(state: PickerState, placeholder: string, value: string): void {
  state.promptInput.visible = true;
  state.promptInput.placeholder = placeholder;
  state.promptInput.value = value;
  state.footer.content = `enter submit${CHROME_SEP}esc back`;
  state.promptInput.focus();
}

function setListMode(state: PickerState): void {
  state.mode = "list";
  state.pending = undefined;
  state.deleteTarget = undefined;
  state.deleteInFlight = false;
  state.workflow = undefined;
  state.inputQueue = [];
  state.inputIndex = 0;
  state.inputValues = {};
  state.inputDomains = {};
  state.resolveGeneration += 1;
  state.choiceOptions = [];
  state.customChoice = false;
  state.progressLines = [];
  showBrowserChrome(state);
  showListChrome(state);
  state.promptInput.value = "";
  state.status.visible = false;
  state.status.content = "";
  state.status.flexGrow = 0;
  applyFilter(state);
  if (state.filter.visible) state.filter.focus();
  else state.list.focus();
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
  state.customChoice = spec.allowCustom === true;
  hideListChrome(state);
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
    state.choiceOptions = spec.options ?? [];
    if (
      shouldRestoreCustomChoiceText(hasAnswer, restored, state.choiceOptions, state.customChoice)
    ) {
      showCustomChoiceText(state, spec, restored ?? "");
      return;
    }
    showBrowserChrome(state);
    applyChoiceFilter(state);
    const preselect = hasAnswer
      ? state.list.options.findIndex((o) => o.value === restored)
      : spec.default
        ? state.list.options.findIndex((o) => o.value === spec.default)
        : 0;
    state.list.setSelectedIndex(Math.max(preselect, 0));
    state.footer.content = state.customChoice ? CUSTOM_CHOICE_HINT : CHOICE_HINT;
    state.filter.focus();
    return;
  }
  state.customChoice = false;
  showCustomChoiceText(state, spec, restored ?? spec.default ?? "");
}

function showCustomChoiceText(state: PickerState, spec: InputSpec, value: string): void {
  state.choiceOptions = [];
  state.filterRow.visible = false;
  state.filter.visible = false;
  state.listBlock.visible = false;
  state.list.visible = false;
  state.list.flexGrow = 0;
  focusTextField(state, `${spec.name}...`, value);
}

function setRunMode(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "run";
  state.running = true;
  state.progressLines = [];
  hideBrowserChrome(state);
  hideListChrome(state);
  showStatus(state, formatRunProgress(entry.name, []), { flexGrow: 1 });
  state.footer.content = RUN_HINT;
}

function finish(state: PickerState, code: number): void {
  state.resolveGeneration += 1;
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
  if (state.list.options.length === 0) return undefined;
  const option = state.list.options[state.list.getSelectedIndex()];
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
  state.mode = "palette";
  state.deleteTarget = undefined;
  state.deleteInFlight = false;
  hideBrowserChrome(state);
  hideListChrome(state);
  showStatus(state, formatPaletteBody(selectedListEntry(state)), { flexGrow: 1 });
  state.footer.content = PALETTE_HINT;
}

function openDeleteConfirm(state: PickerState, entry: WorkflowListEntry): void {
  state.mode = "delete-confirm";
  state.deleteTarget = entry;
  state.deleteInFlight = false;
  hideBrowserChrome(state);
  hideListChrome(state);
  showStatus(state, `Delete ${entry.name} (${entry.source})?\ny  yes, delete\nn  no`, {
    flexGrow: 1,
  });
  state.footer.content = DELETE_CONFIRM_HINT;
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
  state.footer.content = PALETTE_HINT;
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
  state.footer.content = DELETE_CONFIRM_HINT;
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

function previousActiveIndex(state: PickerState): number | undefined {
  const kept: Record<string, string> = {};
  let last: number | undefined;
  for (let i = 0; i < state.inputIndex; i++) {
    const probe = nextActiveInput(state.inputQueue, kept, i);
    if (!probe || probe.index !== i) continue;
    const spec = state.inputQueue[i]!;
    if (Object.hasOwn(state.inputValues, spec.name))
      kept[spec.name] = state.inputValues[spec.name]!;
    last = i;
  }
  return last;
}

function backtrackInput(state: PickerState): void {
  const entry = state.pending;
  if (!entry) {
    setListMode(state);
    return;
  }
  const prev = previousActiveIndex(state);
  if (prev === undefined) {
    setListMode(state);
    return;
  }
  state.resolveGeneration += 1;
  for (const spec of state.inputQueue.slice(prev + 1)) {
    delete state.inputValues[spec.name];
    delete state.inputDomains[spec.name];
  }
  state.inputIndex = prev;
  void advanceInput(state, entry);
}

function handlePickerKey(state: PickerState, key: KeyEvent): void {
  if (state.mode === "run") return handleRunKey(state, key);
  if (state.mode === "palette") return handlePaletteKey(state, key);
  if (state.mode === "delete-confirm") return handleDeleteConfirmKey(state, key);
  if (key.name === "escape") {
    key.preventDefault();
    if (state.mode === "list") finish(state, 0);
    else if (state.mode === "input") backtrackInput(state);
    else setListMode(state);
    return;
  }
  if (state.mode === "input") return handleInputKey(state, key);
  if (tryOpenActionsPalette(state, key)) return;
  navigateSelectList(state, key);
}

/**
 * True when a raw stdin sequence should be dropped as a herdr prefix-key leak.
 * Keeps tab/newline/CR/escape and Ctrl+K (0x0b) so OpenTUI can emit the actions-palette keypress.
 */
export function shouldDropStdinLeakSequence(sequence: string): boolean {
  if (sequence.length !== 1) return false;
  const c = sequence.charCodeAt(0);
  if (c >= 0x20) return false;
  if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b || c === 0x0b) return false;
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
  state.footer.content = FAIL_HINT;
}

/** Declared inputs first, then run. Skips inactive inputs under collected answers. */
async function advanceInput(state: PickerState, entry: WorkflowListEntry): Promise<void> {
  const next = nextActiveInput(state.inputQueue, state.inputValues, state.inputIndex);
  if (!next) {
    void startRun(state, entry);
    return;
  }
  state.inputIndex = next.index;
  const spec = next.spec;
  const startedGeneration = state.resolveGeneration;
  if (spec.type === "choice" && spec.dynamicOptions && !spec.options) {
    state.mode = "input";
    try {
      const cached = state.inputDomains[spec.name];
      const options =
        cached ??
        (await resolveDynamicChoices(entry.file, spec.name, spec.dynamicOptions, state.repoRoot));
      if (!commitResolvedOptions(state, startedGeneration, spec.name, options)) return;
      setInputMode(state, entry, { ...spec, options });
      return;
    } catch (error) {
      if (startedGeneration !== state.resolveGeneration) return;
      showFailure(state, entry, error);
      return;
    }
  }
  if (spec.type === "profile" && !spec.options) {
    const options = profileNames(state.config);
    if (startedGeneration !== state.resolveGeneration) return;
    setInputMode(state, entry, { ...spec, options });
    return;
  }
  setInputMode(state, entry, spec);
}

function storeInput(state: PickerState, value: string): void {
  const entry = state.pending;
  const spec = state.inputQueue[state.inputIndex];
  if (!entry || !spec) return;
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    showStatus(state, `input '${spec.name}' must be at least ${spec.minLength} characters`, {
      warn: true,
    });
    return;
  }
  // Changing an earlier answer invalidates later answers and domains.
  for (const later of state.inputQueue.slice(state.inputIndex + 1)) {
    delete state.inputValues[later.name];
    delete state.inputDomains[later.name];
  }
  state.inputValues[spec.name] = value;
  state.inputIndex += 1;
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
    state.detail.content = formatDetailLines(err, state.contentWidth);
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
    state.inputDomains = {};
    state.resolveGeneration += 1;
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

export async function startRun(state: PickerState, entry: WorkflowListEntry): Promise<void> {
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
      domains: state.inputDomains,
      onProgressLine: (line) => {
        if (state.exit) return;
        state.progressLines.push(truncate(line, state.contentWidth));
        showStatus(state, formatRunProgress(entry.name, state.progressLines), { flexGrow: 1 });
      },
    });
    state.runHandle = handle;
    const result = await handle.result;
    if (state.exit) return;
    state.runHandle = undefined;
    state.running = false;
    showStatus(
      state,
      formatRunProgress(entry.name, state.progressLines, {
        ok: result.ok,
        detail: result.ok ? "" : result.detail,
      }),
      { flexGrow: 1 },
    );
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

function buildPickerBrowserChrome(theme: HostTheme) {
  return [
    Box(
      { id: "filter-row", flexDirection: "row", width: "100%" },
      Text({ content: "/ ", ...theme.text }),
      Input({ id: "filter", flexGrow: 1, placeholder: "filter...", ...theme.input }),
      Text({
        id: "update-hint",
        content: "",
        visible: false,
        attributes: TextAttributes.DIM,
        ...theme.text,
      }),
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
        showSelectionIndicator: false,
        wrapSelection: true,
        itemSpacing: 0,
        ...theme.select,
      }),
      Text({ content: " " }),
    ),
  ] as const;
}

function buildPickerDetailStack(theme: HostTheme) {
  return [
    Text({
      id: "status",
      content: "",
      visible: false,
      flexGrow: 1,
      ...theme.text,
    }),
    Text({ id: "detail", content: "", height: 2, attributes: TextAttributes.DIM, ...theme.text }),
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
      placeholder: "prompt...",
      ...theme.input,
    }),
    Text({ id: "footer", content: LIST_HINT, attributes: TextAttributes.DIM, ...theme.text }),
  ] as const;
}

function mountPickerUi(renderer: CliRenderer, theme: HostTheme) {
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
      ...buildPickerBrowserChrome(theme),
      ...buildPickerDetailStack(theme),
    ),
  );
  return {
    renderer,
    filterRow: renderer.root.findDescendantById("filter-row") as BoxRenderable,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    updateHint: renderer.root.findDescendantById("update-hint") as TextRenderable,
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
      if (typeof option.value === "string" || isCustomChoiceValue(option.value)) {
        submitInputChoice(state, option.value);
      }
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
  state.promptInput.on(InputRenderableEvents.ENTER, (value) => submitInputText(state, value));
  state.renderer.keyInput.on("keypress", (key) => handlePickerKey(state, key));
  state.renderer.on("resize", (width: number) => {
    state.contentWidth = pickerContentWidth(width);
    state.rule.content = formatRule(state.contentWidth);
    if (state.mode === "list") {
      applyFilter(state);
      refreshUpdateHint(state);
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
  leaveManagedCheckout(opts.repoRoot, opts.chdir);

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
  const ui = mountPickerUi(renderer, theme);

  const state: PickerState = {
    mode: "list",
    entries: opts.entries,
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    inputDomains: {},
    resolveGeneration: 0,
    choiceOptions: [],
    customChoice: false,
    running: false,
    progressLines: [],
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
    ...ui,
  };

  applyNewer = (version) => {
    state.newerReleaseVersion = version;
    refreshUpdateHint(state);
  };
  if (pendingNewer) applyNewer(pendingNewer);

  bindPickerEvents(state);
  setListMode(state);

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });

  return state.exit?.code ?? 0;
}
