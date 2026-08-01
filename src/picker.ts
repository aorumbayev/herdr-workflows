import { basename } from "node:path";
import { unlink } from "node:fs/promises";
import { compareSemver, fetchLatestPublishedRelease } from "./cli";
import { createInputSession, type InputSession } from "./workflow/inputs-exchange";
import { exportWorkflowBundle } from "./workflow/inputs-exchange";
import {
  formatElapsed,
  listRuns,
  statusLabel,
  allocateRunId,
  canonicalRepoRoot,
  normalizeRunUuid,
  optimisticRunningDetail,
  parseHistoryAck,
  presentDetail,
  runDetail,
  type RunDetail,
  type RunDetailBlock,
  type RunListItem,
  type RunProjectedStatus,
} from "./history";
import {
  launchDetachedRun,
  launchDetachedWeb,
  type DetachedRunHandle,
  type LaunchRunRequest,
  type LaunchWebRequest,
} from "./engine";
import {
  LIST_VIEWPORT,
  mountChrome,
  type ChromeOption,
  type PickerChrome,
  type ChromeKeyEvent,
  type HostTheme,
} from "./chrome";
import { notificationShow } from "./host";
import { openInBrowser } from "./cli";
import { runWorkbenchRoute, parseWebRoute } from "./workbench";
import {
  sanitizeDisplay,
  latest,
  EXAMPLES_URL,
  PRODUCT_VERSION,
  loadContext,
  type InvocationContext,
  type WorkflowsConfig,
} from "./context";
import {
  sensitivityLabels,
  workflowDisplayTitle,
  analyzeResolvedSensitivity,
  listWorkflows,
  loadWorkflowEntry,
} from "./workflow/inputs-exchange";
import type { WorkflowListEntry, InputSpec, LoadedWorkflow } from "./workflow/grammar";

export const EMPTY_CATALOG_MESSAGE =
  "Hi there, looks like you got no runnable workflows, start by creating a new one, browsing examples or importing an existing workflow.";

export const EMPTY_LIST_HINT = `tab runs | ctrl+k | esc`;
export const PALETTE_HINT = `letter fires | esc back`;
export const DELETE_CONFIRM_HINT = `y delete | n cancel | esc`;

export type ResolvedPaletteAction =
  | { id: "new"; route: "new" }
  | { id: "import"; route: "import" }
  | { id: "examples" }
  | { id: "open"; route: string }
  | { id: "share"; entry: WorkflowListEntry }
  | { id: "delete"; entry: WorkflowListEntry };

export function resolvePaletteLetter(
  letter: string,
  selected: WorkflowListEntry | undefined,
): ResolvedPaletteAction | undefined {
  const key = letter.toLowerCase();
  if (key.length !== 1) return undefined;
  if (key === "n") return { id: "new", route: "new" };
  if (key === "i") return { id: "import", route: "import" };
  if (key === "e") return { id: "examples" };
  if (!selected || selected.error) return undefined;
  if (key === "o") return { id: "open", route: `w=${selected.source}:${selected.name}` };
  if (key === "s") return { id: "share", entry: selected };
  if (key === "d") return { id: "delete", entry: selected };
  return undefined;
}

export function formatPaletteBody(selected: WorkflowListEntry | undefined): string {
  const lines = ["n  Create new", "i  Import", "e  Browse examples"];
  if (selected && !selected.error) {
    lines.push(
      `o  Open ${selected.name}`,
      `s  Share ${selected.name} (copy)`,
      `d  Delete ${selected.name}`,
    );
  } else {
    lines.push(
      "o  Open (needs selection)",
      "s  Share (needs selection)",
      "d  Delete (needs selection)",
    );
  }
  return lines.join("\n");
}

async function copyTextToClipboard(text: string): Promise<void> {
  const trySpawn = async (cmd: string[]): Promise<boolean> => {
    try {
      const proc = Bun.spawn(cmd, {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc.stdin.write(text);
      await proc.stdin.end();
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin" && (await trySpawn(["pbcopy"]))) return;
  if (await trySpawn(["wl-copy"])) return;
  if (await trySpawn(["xclip", "-selection", "clipboard"])) return;
  throw new Error("no clipboard command (pbcopy, wl-copy, or xclip)");
}

export async function shareWorkflowCopy(opts: {
  entry: WorkflowListEntry;
  repoRoot: string;
}): Promise<void> {
  const exported = await exportWorkflowBundle({
    name: opts.entry.name,
    scope: opts.entry.source,
    repoRoot: opts.repoRoot,
  });
  await copyTextToClipboard(exported.command);
  await notificationShow(`Workflow ${opts.entry.name} has been copied to clipboard`);
}

export async function deleteWorkflowFile(entry: WorkflowListEntry): Promise<void> {
  await unlink(entry.file);
}

/** Escape while a run is in flight dismisses with 0; Escape after failure is nonzero. */
export function pickerEscapeExitCode(mode: string, running: boolean): number {
  if (mode === "run") return running ? 0 : 1;
  return 0;
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

export function shouldDropStdinLeakSequence(sequence: string): boolean {
  if (sequence.length !== 1) return false;
  const c = sequence.charCodeAt(0);
  if (c >= 0x20) return false;
  if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b || c === 0x0b || c === 0x07) {
    return false;
  }
  return true;
}

/** Width-bounded list-mode filter-row hint (printable ASCII only). */
export const UPDATE_INDICATOR = "[run hwf update]";

/** Minimum filter field width reserved before the indicator may appear. */
const MIN_FILTER_FIELD = 4;
/** Filter-row prefix `"/ "` plus a separating space before the indicator. */
const FILTER_ROW_OVERHEAD = 3;

export function updateAvailable(embedded: string, latest: string): boolean {
  try {
    return compareSemver(embedded, latest) < 0;
  } catch {
    return false;
  }
}

/**
 * Return the indicator text when `contentWidth` can fit `/ ` + a short filter
 * field + the ASCII hint; otherwise empty (hide rather than truncate meaning).
 */
export function formatFilterUpdateHint(contentWidth: number): string {
  if (contentWidth < FILTER_ROW_OVERHEAD + MIN_FILTER_FIELD + UPDATE_INDICATOR.length) {
    return "";
  }
  return UPDATE_INDICATOR;
}

export type PickerUpdateCheck = {
  check: () => Promise<{ version: string } | null>;
  embeddedVersion: string;
  onNewer: (version: string) => void;
};

/** Fire-and-forget latest-release check; never throws to the caller. */
export function startPickerUpdateCheck(opts: PickerUpdateCheck): void {
  void opts
    .check()
    .then((latest) => {
      if (!latest) return;
      if (updateAvailable(opts.embeddedVersion, latest.version)) {
        opts.onNewer(latest.version);
      }
    })
    .catch(() => {
      // Timeout, network, rate-limit, parse — ignore.
    });
}

export async function defaultPickerReleaseCheck(): Promise<{ version: string } | null> {
  try {
    return await fetchLatestPublishedRelease();
  } catch {
    return null;
  }
}

const ELLIPSIS = "...";
export const CHROME_SEP = " | ";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// SelectRenderable draws name at contentX+1+indicatorWidth; indicator off → pad 1 only.
const SELECT_NAME_OFFSET = 1;
const CURSOR_PREFIX_WIDTH = 2;
const ROW_TEXT_INDENT = SELECT_NAME_OFFSET + CURSOR_PREFIX_WIDTH;
const LOCATION_WIDTH = 7;
const WARNING_WIDTH = 2;

type PickerRowValue = { entry: WorkflowListEntry };

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

export const LIST_HINT = `tab runs${CHROME_SEP}enter run${CHROME_SEP}ctrl+k${CHROME_SEP}esc`;
const CHOICE_HINT = `type filter${CHROME_SEP}up/down move${CHROME_SEP}enter select${CHROME_SEP}esc back`;
const CUSTOM_CHOICE_HINT = `type filter${CHROME_SEP}up/down${CHROME_SEP}enter select/custom${CHROME_SEP}esc back`;
const RUN_HINT = `esc dismiss${CHROME_SEP}run continues`;
const FAIL_HINT = "enter/esc close";
const CUSTOM_CHOICE_LABEL = "custom...";

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

export { CHOICE_HINT, CUSTOM_CHOICE_HINT, CUSTOM_CHOICE_LABEL, FAIL_HINT, RUN_HINT };

/** What the prompt is collecting, then how to answer it. */
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

/** Selected valid row in list mode, or undefined when the filtered list is empty. */
export function selectedListEntry(state: { chrome: PickerChrome }): WorkflowListEntry | undefined {
  if (state.chrome.options().length === 0) return undefined;
  const option = state.chrome.options()[state.chrome.selectedIndex()];
  const value = option?.value as PickerRowValue | undefined;
  return value?.entry;
}

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

/** Truncate to `max` terminal columns at a grapheme boundary. */
export function truncate(text: string, max: number): string {
  if (columns(text) <= max) return text;
  if (max <= 0) return "";
  const ellipsisCols = columns(ELLIPSIS);
  if (max < ellipsisCols) return takeColumns(ELLIPSIS, max);
  return `${takeColumns(text, max - ellipsisCols)}${ELLIPSIS}`;
}

export function stripFilePrefix(error: string, file: string): string {
  return error.startsWith(file) ? error.slice(file.length).replace(/^[,:]\s*/, "") : error;
}

export function entrySensitivity(entry: WorkflowListEntry): string[] {
  return sensitivityLabels({
    hasCommands: entry.hasCommands === true,
    hasTranscript: entry.needsTranscript === true,
    sensitiveMethods: entry.sensitiveMethods ?? [],
    unresolvedChildren: entry.unresolvedChildren ?? [],
  });
}

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

export function buildPickerOptions(valid: WorkflowListEntry[], rowWidth: number): ChromeOption[] {
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
): ChromeOption[] {
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

const SEP = " · ";

export type RunsScope = "current" | "all";

/** Shared list/detail summary: status · display id · checkout root. */
export function formatRunSummary(run: {
  status: RunProjectedStatus;
  display_id: string;
  checkout_root: string;
}): string {
  return [statusLabel(run.status), run.display_id, run.checkout_root].join(SEP);
}

export function formatRunListEmpty(opts: {
  scope: "current" | "all";
  hasMachineRuns: boolean;
  filterActive: boolean;
  unavailable?: boolean;
}): string {
  if (opts.unavailable) return "run history unavailable";
  if (opts.filterActive) return "no matching runs";
  if (!opts.hasMachineRuns) return "no workflow has run yet";
  if (opts.scope === "current") return `no runs in this worktree${SEP}Ctrl+G for All`;
  return "no runs";
}

export function formatRunsOptions(
  items: RunListItem[],
  width: number,
  scope: RunsScope,
): { name: string; description: string; value: { run: RunListItem } }[] {
  return items.map((run) => ({
    name: formatRunRow(run, width, { showLocation: scope === "all" }),
    description: formatRunSummary(run),
    value: { run },
  }));
}

export function runsFooter(scope: RunsScope, index: number, total: number): string {
  const scopeLabel = scope === "current" ? "Current" : "All";
  const pos = total === 0 ? "0/0" : `${index + 1}/${total}`;
  return `tab workflows · ctrl+g ${scopeLabel} · enter detail · esc quit · ${pos}`;
}

export function runDetailFooter(opts: { allowWorkbench?: boolean } = {}): string {
  const allow = opts.allowWorkbench !== false;
  return allow ? "w workbench · esc back · up/down scroll" : "esc back · up/down scroll";
}

function abbreviateStatus(status: RunProjectedStatus, width: number): string {
  const full = statusLabel(status);
  if (full.length <= width) return full;
  if (status === "interrupted") return width >= 5 ? "INTR" : "I";
  if (status === "succeeded") return width >= 4 ? "OK" : "O";
  if (status === "failed") return width >= 4 ? "FAIL" : "F";
  if (status === "running") return width >= 3 ? "RUN" : "R";
  if (status === "stale") return width >= 3 ? "STL" : "S";
  return width >= 3 ? "…" : "";
}

/** One list row; priority: status, progress, elapsed, workflow, optional location. */
export function formatRunRow(
  item: RunListItem,
  width: number,
  opts: { showLocation?: boolean } = {},
): string {
  const status = abbreviateStatus(item.status, Math.min(12, Math.max(3, width)));
  const progress =
    item.progress !== undefined ? `${item.progress.done}/${item.progress.total}` : "";
  const elapsed = formatElapsed(item.elapsed_ms);
  const location = opts.showLocation ? basename(item.checkout_root) : "";
  const fixed = [status, progress, elapsed].filter(Boolean);
  const fixedWidth = fixed.reduce((n, part) => n + part.length + SEP.length, 0);
  let remain = Math.max(0, width - fixedWidth);
  let workflow = item.title || item.workflow;
  let loc = location;
  if (loc && remain > 0) {
    const locBudget = Math.min(loc.length, Math.max(0, Math.floor(remain / 3)));
    loc = truncate(loc, locBudget);
    remain -= loc ? loc.length + SEP.length : 0;
  } else {
    loc = "";
  }
  workflow = truncate(workflow, remain);
  return [status, workflow, progress, elapsed, loc].filter(Boolean).join(SEP);
}

function blockToLines(block: RunDetailBlock, width: number): string[] {
  if (block.kind === "head") {
    const head = [block.status, block.title, block.display_id, block.elapsed]
      .filter(Boolean)
      .join(SEP);
    return [truncate(head, width)];
  }
  if (block.kind === "note" || block.kind === "error") {
    return [truncate(block.text, width)];
  }
  const indent = "  ".repeat(block.depth);
  const outcome = block.outcome ? `${SEP}${block.outcome}` : "";
  const lines = [
    truncate(`${indent}${block.ordinal}/${block.total} ${block.label}${outcome}`, width),
  ];
  if (block.explanation) {
    lines.push(truncate(`${indent}  ${block.explanation}`, width));
  }
  return lines;
}

export function formatRunDetailLines(blocks: RunDetailBlock[], width: number): string[] {
  return blocks.flatMap((block) => blockToLines(block, width));
}

function formatStartingDetail(workflow: string, id: string, width: number): string[] {
  return [
    truncate(`STARTING${SEP}${workflow}${SEP}${id.slice(0, 8)}`, width),
    truncate("claiming run history…", width),
  ];
}

export type RunsBrowserState = {
  scope: RunsScope;
  filter: string;
  items: RunListItem[];
  selectedId?: string;
  hasMachineRuns: boolean;
  unavailable: boolean;
};

export type RunDetailView =
  | { kind: "starting"; id: string; workflow: string }
  | { kind: "local-failure"; id: string; workflow: string; message: string }
  | {
      kind: "history-unavailable";
      id: string;
      workflow: string;
      progress: string[];
      finished?: "succeeded" | "failed";
      message?: string;
    }
  | { kind: "detail"; detail: RunDetail; blocks: RunDetailBlock[]; progress?: string[] };

export function viewAllowsWorkbench(view: RunDetailView): boolean {
  return (
    view.kind !== "history-unavailable" && view.kind !== "local-failure" && view.kind !== "starting"
  );
}

export async function loadRunsBrowser(
  checkoutRoot: string,
  scope: RunsScope,
  filter: string,
  preserveId?: string,
): Promise<RunsBrowserState> {
  const allProbe = await listRuns({ checkout_root: null });
  const hasMachineRuns = allProbe.ok && allProbe.runs.length > 0;
  if (!allProbe.ok) {
    return {
      scope,
      filter,
      items: [],
      hasMachineRuns: false,
      unavailable: true,
    };
  }
  const listed = await listRuns({
    checkout_root: scope === "current" ? checkoutRoot : null,
    text: filter,
  });
  if (!listed.ok) {
    return {
      scope,
      filter,
      items: [],
      hasMachineRuns,
      unavailable: true,
    };
  }
  const selectedId =
    preserveId !== undefined && listed.runs.some((r) => r.id === preserveId)
      ? preserveId
      : listed.runs[0]?.id;
  return {
    scope,
    filter,
    items: listed.runs,
    ...(selectedId !== undefined ? { selectedId } : {}),
    hasMachineRuns,
    unavailable: false,
  };
}

export function detailLines(view: RunDetailView, width: number): string[] {
  if (view.kind === "starting") return formatStartingDetail(view.workflow, view.id, width);
  if (view.kind === "local-failure") {
    return [
      `LAUNCH FAILED · ${view.workflow} · ${view.id.slice(0, 8)}`.slice(0, width),
      view.message.slice(0, width),
    ];
  }
  if (view.kind === "history-unavailable") {
    const head = view.finished
      ? `${view.finished.toUpperCase()} · HISTORY UNAVAILABLE · ${view.workflow}`
      : `RUNNING · HISTORY UNAVAILABLE · ${view.workflow}`;
    const lines = [head.slice(0, width), ...view.progress.map((line) => line.slice(0, width))];
    if (view.message) lines.push(view.message.slice(0, width));
    return lines;
  }
  const lines = formatRunDetailLines(view.blocks, width);
  if (view.progress?.length) {
    return [...lines, "", ...view.progress.map((line) => line.slice(0, width))];
  }
  return lines;
}

/** Shared with picker Select height — six visible rows, scroll for the rest. */
export const RUNS_LIST_VIEWPORT = LIST_VIEWPORT;

export function runsSelectedIndex(
  items: readonly { id: string }[],
  selectedId: string | undefined,
): number {
  const idx = items.findIndex((item) => item.id === selectedId);
  return Math.max(0, idx);
}

export function scrollDetailLines(
  lines: string[],
  scroll: number,
  viewport: number,
): { visible: string[]; scroll: number } {
  const maxScroll = Math.max(0, lines.length - viewport);
  const next = Math.min(Math.max(0, scroll), maxScroll);
  return { visible: lines.slice(next, next + viewport), scroll: next };
}

type StartRunLaunch = {
  ctx: InvocationContext;
  config: WorkflowsConfig;
  inputValues: Record<string, string>;
  inputDomains: Record<string, string[]>;
  workflow?: LoadedWorkflow;
  loadWorkflow: (
    entry: WorkflowListEntry,
    repoRoot: string,
    config: WorkflowsConfig,
  ) => Promise<LoadedWorkflow>;
  launchRun?: (req: LaunchRunRequest) => DetachedRunHandle;
  getExit: () => { code: number } | undefined;
};

export type RunsBrowserDeps = {
  repoRoot: string;
  getContentWidth: () => number;
  chrome: PickerChrome;
  launchWorkbenchRoute: (route: string) => void;
};

type BrowserView = "list" | "detail";

type RunsBrowserSession = {
  deps: RunsBrowserDeps;
  view: BrowserView | null;
  scope: RunsScope;
  browserState?: RunsBrowserState;
  refreshToken: ReturnType<typeof latest>;
  detailView?: RunDetailView;
  detailScroll: number;
  detailPoll?: ReturnType<typeof setInterval>;
  detailToken: ReturnType<typeof latest>;
  activeRunId?: string;
  savedFilter: string;
  running: boolean;
  progressLines: string[];
  workflow?: LoadedWorkflow;
  runHandle?: DetachedRunHandle;
};

export type RunsBrowser = {
  enter(): Promise<void>;
  leave(): void;
  handleKey(key: ChromeKeyEvent): boolean;
  dispose(): void;
  refresh(): Promise<void>;
  onSelectionChanged(): void;
  onFilterInput(): void;
  onResize(): void;
  startRun(entry: WorkflowListEntry, launch: StartRunLaunch): Promise<void>;
  openDetail(id: string): Promise<void>;
  openSelected(): void;
  isActive(): boolean;
  isDetail(): boolean;
  readonly running: boolean;
};

function applyListOptions(
  session: RunsBrowserSession,
  options: Parameters<PickerChrome["setOptions"]>[0],
): void {
  session.deps.chrome.setOptions(options);
}

function stopDetailPoll(session: RunsBrowserSession): void {
  if (session.detailPoll !== undefined) {
    clearInterval(session.detailPoll);
    session.detailPoll = undefined;
  }
}

function detachRun(session: RunsBrowserSession): void {
  session.runHandle?.detach();
  session.runHandle = undefined;
  session.running = false;
}

/** Terminal snapshots do not poll; only live/stale snapshot detail refreshes. */
export function isDetailPollableStatus(status: string): boolean {
  return status === "running" || status === "stale";
}

function detailIsPollable(session: RunsBrowserSession): boolean {
  if (session.view !== "detail") return false;
  if (!session.activeRunId || !normalizeRunUuid(session.activeRunId)) return false;
  if (!session.detailView || session.detailView.kind !== "detail") return false;
  if (session.detailView.detail.kind !== "snapshot") return false;
  return isDetailPollableStatus(session.detailView.detail.status);
}

function beginDetailPollRequest(
  session: RunsBrowserSession,
): { id: string; gen: number } | undefined {
  if (!detailIsPollable(session)) return undefined;
  const id = session.activeRunId!;
  return { id, gen: session.detailToken.begin() };
}

function detailPollResponseCurrent(session: RunsBrowserSession, id: string, gen: number): boolean {
  return (
    session.view === "detail" && session.activeRunId === id && session.detailToken.current(gen)
  );
}

function selectedRunSummary(session: RunsBrowserSession): string {
  const selected = session.browserState?.items[session.deps.chrome.selectedIndex()];
  if (!selected) return "";
  return formatRunSummary(selected);
}

function paintRunsSelection(session: RunsBrowserSession, total: number): void {
  session.deps.chrome.setDetail(
    formatDetailLines(selectedRunSummary(session), session.deps.getContentWidth()),
  );
  session.deps.chrome.setFooter(
    runsFooter(session.scope, session.deps.chrome.selectedIndex(), total),
  );
}

function preserveSelectionId(session: RunsBrowserSession): string | undefined {
  return (
    session.browserState?.selectedId ??
    session.browserState?.items[session.deps.chrome.selectedIndex()]?.id ??
    session.activeRunId
  );
}

function renderDetail(session: RunsBrowserSession): void {
  if (!session.detailView) return;
  const lines = detailLines(session.detailView, session.deps.getContentWidth());
  const { visible, scroll } = scrollDetailLines(lines, session.detailScroll, 10);
  session.detailScroll = scroll;
  session.deps.chrome.showDetailLayout();
  session.deps.chrome.status(visible.join("\n"), { flexGrow: 1 });
  session.deps.chrome.setFooter(
    runDetailFooter({
      allowWorkbench: viewAllowsWorkbench(session.detailView),
    }),
  );
}

async function refreshOpenDetail(session: RunsBrowserSession): Promise<void> {
  const req = beginDetailPollRequest(session);
  if (!req) {
    stopDetailPoll(session);
    return;
  }
  const view = await runDetail(req.id);
  if (!detailPollResponseCurrent(session, req.id, req.gen)) return;
  session.detailView = { kind: "detail", ...view };
  renderDetail(session);
  if (!detailIsPollable(session)) stopDetailPoll(session);
}

function startDetailPoll(session: RunsBrowserSession): void {
  stopDetailPoll(session);
  if (!detailIsPollable(session)) return;
  const timer = setInterval(() => {
    void refreshOpenDetail(session);
  }, 3000);
  timer.unref?.();
  session.detailPoll = timer;
}

async function refresh(session: RunsBrowserSession): Promise<void> {
  if (session.view !== "list") return;
  const gen = session.refreshToken.begin();
  const currentScope = session.scope;
  const filter = session.deps.chrome.filterValue();
  const view = session.view;
  const preserveId = preserveSelectionId(session);
  const browser = await loadRunsBrowser(session.deps.repoRoot, currentScope, filter, preserveId);
  if (
    !session.refreshToken.current(gen) ||
    session.view !== view ||
    session.scope !== currentScope ||
    session.deps.chrome.filterValue() !== filter
  ) {
    return;
  }
  session.browserState = browser;
  session.deps.chrome.showBrowser({
    filterPlaceholder: "filter runs...",
    filterValue: filter,
    showFilter: true,
    listHeight: RUNS_LIST_VIEWPORT,
  });
  session.deps.chrome.showList("");
  if (browser.unavailable || browser.items.length === 0) {
    applyListOptions(session, []);
    session.deps.chrome.setDetail(
      formatDetailLines(
        formatRunListEmpty({
          scope: browser.scope,
          hasMachineRuns: browser.hasMachineRuns,
          filterActive: browser.filter.trim().length > 0,
          unavailable: browser.unavailable,
        }),
        session.deps.getContentWidth(),
      ),
    );
    session.deps.chrome.setFooter(runsFooter(session.scope, 0, 0));
    return;
  }
  const options = formatRunsOptions(browser.items, session.deps.getContentWidth(), session.scope);
  applyListOptions(session, options);
  const idx = runsSelectedIndex(browser.items, browser.selectedId);
  session.deps.chrome.setSelectedIndex(idx);
  session.browserState.selectedId = browser.items[idx]?.id;
  paintRunsSelection(session, options.length);
}

async function enter(session: RunsBrowserSession): Promise<void> {
  stopDetailPoll(session);
  const preserveFromDetail = session.activeRunId;
  session.running = false;
  session.progressLines = [];
  session.workflow = undefined;
  session.view = "list";
  session.detailView = undefined;
  if (preserveFromDetail && session.browserState) {
    session.browserState.selectedId = preserveFromDetail;
  }
  session.activeRunId = undefined;
  session.deps.chrome.clearStatus();
  session.deps.chrome.showBrowser({
    filterPlaceholder: "filter runs...",
    filterValue: session.savedFilter,
    showFilter: true,
  });
  session.deps.chrome.showList("");
  await refresh(session);
  session.deps.chrome.focusFilter();
}

function leave(session: RunsBrowserSession): void {
  stopDetailPoll(session);
  session.view = null;
  session.detailView = undefined;
  session.activeRunId = undefined;
}

async function openDetail(session: RunsBrowserSession, id: string): Promise<void> {
  session.view = "detail";
  session.activeRunId = id;
  session.detailScroll = 0;
  const gen = session.detailToken.begin();
  const view = await runDetail(id);
  if (
    session.view !== "detail" ||
    session.activeRunId !== id ||
    !session.detailToken.current(gen)
  ) {
    return;
  }
  session.detailView = { kind: "detail", ...view };
  renderDetail(session);
  startDetailPoll(session);
}

function openSelected(session: RunsBrowserSession): void {
  const selected = session.browserState?.items[session.deps.chrome.selectedIndex()];
  if (selected) void openDetail(session, selected.id);
}

function toggleScope(session: RunsBrowserSession): void {
  if (session.view !== "list") return;
  session.scope = session.scope === "current" ? "all" : "current";
  void refresh(session);
}

function onSelectionChanged(session: RunsBrowserSession): void {
  if (session.view !== "list" || !session.browserState) return;
  const selected = session.browserState.items[session.deps.chrome.selectedIndex()];
  if (selected) session.browserState.selectedId = selected.id;
  session.activeRunId = undefined;
  paintRunsSelection(session, session.deps.chrome.options().length);
}

function onFilterInput(session: RunsBrowserSession): void {
  session.savedFilter = session.deps.chrome.filterValue();
  void refresh(session);
}

function onResize(session: RunsBrowserSession): void {
  if (session.view === "list") void refresh(session);
  else if (session.view === "detail") renderDetail(session);
}

function handleDetailKey(session: RunsBrowserSession, key: ChromeKeyEvent): boolean {
  if (key.name === "escape") {
    key.preventDefault();
    detachRun(session);
    stopDetailPoll(session);
    void enter(session);
    return true;
  }
  if (key.name === "up") {
    key.preventDefault();
    session.detailScroll = Math.max(0, session.detailScroll - 1);
    renderDetail(session);
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    session.detailScroll += 1;
    renderDetail(session);
    return true;
  }
  if (key.name === "w" && !key.ctrl && !key.meta) {
    key.preventDefault();
    const id = session.activeRunId;
    if (!id || !normalizeRunUuid(id)) return true;
    if (!session.detailView || !viewAllowsWorkbench(session.detailView)) return true;
    stopDetailPoll(session);
    session.deps.launchWorkbenchRoute(runWorkbenchRoute(id));
    session.deps.chrome.setFooter(runDetailFooter());
    return true;
  }
  return true;
}

function handleKey(session: RunsBrowserSession, key: ChromeKeyEvent): boolean {
  if (session.view === "detail") return handleDetailKey(session, key);
  if (session.view !== "list") return false;
  if (key.ctrl && (key.name === "g" || key.sequence === "\x07")) {
    key.preventDefault();
    toggleScope(session);
    return true;
  }
  if (key.name === "up") {
    key.preventDefault();
    session.deps.chrome.moveUp();
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    session.deps.chrome.moveDown();
    return true;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    openSelected(session);
    return true;
  }
  return false;
}

function setStartingDetail(
  session: RunsBrowserSession,
  entry: WorkflowListEntry,
  runId: string,
): void {
  stopDetailPoll(session);
  session.view = "detail";
  session.running = true;
  session.activeRunId = runId;
  session.detailScroll = 0;
  session.progressLines = [];
  session.detailToken.begin();
  session.detailView = { kind: "starting", id: runId, workflow: entry.name };
  renderDetail(session);
}

function runningDetailView(
  runId: string,
  entry: WorkflowListEntry,
  checkoutRoot: string,
  progress: string[],
): RunDetailView {
  return {
    kind: "detail",
    ...presentDetail(
      optimisticRunningDetail({
        id: runId,
        workflow: entry.name,
        source: entry.source,
        checkout_root: checkoutRoot,
      }),
    ),
    progress,
  };
}

function launchCancelled(
  session: RunsBrowserSession,
  launch: StartRunLaunch,
  runId: string,
): boolean {
  return Boolean(launch.getExit()) || session.view !== "detail" || session.activeRunId !== runId;
}

function withProgress(
  session: RunsBrowserSession,
  runId: string,
  entry: WorkflowListEntry,
  checkoutRoot: string,
  historyState: "pending" | "claimed" | "unavailable",
): void {
  if (session.detailView?.kind === "detail" || session.detailView?.kind === "history-unavailable") {
    session.detailView = { ...session.detailView, progress: session.progressLines };
  } else if (session.detailView?.kind === "starting" && historyState === "claimed") {
    session.detailView = runningDetailView(runId, entry, checkoutRoot, session.progressLines);
  }
}

async function startRun(
  session: RunsBrowserSession,
  entry: WorkflowListEntry,
  launch: StartRunLaunch,
): Promise<void> {
  const inputs = Object.fromEntries(
    Object.entries(launch.inputValues).map(([key, value]) => [key, sanitizeDisplay(value)]),
  );
  const runId = allocateRunId();
  const checkoutRoot = await canonicalRepoRoot(session.deps.repoRoot);
  setStartingDetail(session, entry, runId);
  try {
    session.workflow =
      launch.workflow ??
      session.workflow ??
      (await launch.loadWorkflow(entry, session.deps.repoRoot, launch.config));
    const launchFn = launch.launchRun ?? launchDetachedRun;
    const history = { state: "pending" as "pending" | "claimed" | "unavailable" };
    const handle = launchFn({
      name: entry.name,
      repoRoot: session.deps.repoRoot,
      ctx: launch.ctx,
      inputs,
      domains: launch.inputDomains,
      runId,
      onHistoryAck: (line) => {
        if (launchCancelled(session, launch, runId)) return;
        const ack = parseHistoryAck(line);
        if (!ack) return;
        if (ack.state === "claimed" && ack.id === runId) {
          history.state = "claimed";
          session.detailView = runningDetailView(runId, entry, checkoutRoot, session.progressLines);
          renderDetail(session);
          startDetailPoll(session);
          return;
        }
        if (ack.state === "unavailable") {
          history.state = "unavailable";
          stopDetailPoll(session);
          session.detailView = {
            kind: "history-unavailable",
            id: runId,
            workflow: entry.name,
            progress: session.progressLines,
          };
          renderDetail(session);
        }
      },
      onProgressLine: (line) => {
        if (launchCancelled(session, launch, runId)) return;
        session.progressLines.push(truncate(line, session.deps.getContentWidth()));
        withProgress(session, runId, entry, checkoutRoot, history.state);
        renderDetail(session);
      },
    });
    session.runHandle = handle;
    const result = await handle.result;
    if (launchCancelled(session, launch, runId)) return;
    session.runHandle = undefined;
    session.running = false;
    stopDetailPoll(session);
    if (history.state === "pending" && !result.ok) {
      session.detailView = {
        kind: "local-failure",
        id: runId,
        workflow: entry.name,
        message: result.detail || "launch failed",
      };
      renderDetail(session);
      return;
    }
    if (history.state === "unavailable") {
      session.detailView = {
        kind: "history-unavailable",
        id: runId,
        workflow: entry.name,
        progress: session.progressLines,
        finished: result.ok ? "succeeded" : "failed",
        ...(result.ok ? {} : { message: result.detail }),
      };
      renderDetail(session);
      return;
    }
    const gen = session.detailToken.begin();
    const view = await runDetail(runId);
    if (
      session.view !== "detail" ||
      session.activeRunId !== runId ||
      !session.detailToken.current(gen)
    ) {
      return;
    }
    session.detailView = { kind: "detail", ...view };
    renderDetail(session);
    startDetailPoll(session);
  } catch (error) {
    session.runHandle = undefined;
    session.running = false;
    stopDetailPoll(session);
    session.detailView = {
      kind: "local-failure",
      id: runId,
      workflow: entry.name,
      message: error instanceof Error ? error.message : String(error),
    };
    renderDetail(session);
  }
}

export function createRunsBrowser(deps: RunsBrowserDeps): RunsBrowser {
  const session: RunsBrowserSession = {
    deps,
    view: null,
    scope: "current",
    refreshToken: latest(),
    detailScroll: 0,
    detailToken: latest(),
    savedFilter: "",
    running: false,
    progressLines: [],
  };
  return {
    enter: () => enter(session),
    leave: () => leave(session),
    handleKey: (key) => handleKey(session, key),
    dispose: () => {
      detachRun(session);
      stopDetailPoll(session);
      session.view = null;
    },
    refresh: () => refresh(session),
    onSelectionChanged: () => onSelectionChanged(session),
    onFilterInput: () => onFilterInput(session),
    onResize: () => onResize(session),
    startRun: (entry, launch) => startRun(session, entry, launch),
    openDetail: (id) => openDetail(session, id),
    openSelected: () => openSelected(session),
    isActive: () => session.view !== null,
    isDetail: () => session.view === "detail",
    get running() {
      return session.running;
    },
  };
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

const CUSTOM_CHOICE_VALUE: CustomChoiceValue = { kind: "custom" };

function pickerContentWidth(rendererWidth: number): number {
  return Math.max(0, rendererWidth - 2);
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
