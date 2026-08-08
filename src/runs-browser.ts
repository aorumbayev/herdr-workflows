import { basename } from "node:path";
import {
  formatElapsed,
  formatProgressLine,
  listRuns,
  statusLabel,
  allocateRunId,
  canonicalRepoRoot,
  normalizeRunUuid,
  optimisticRunningDetail,
  parseHistoryAck,
  parseProgressLine,
  presentDetail,
  runDetail,
  type RunDetail,
  type RunDetailBlock,
  type RunListItem,
  type RunProjectedStatus,
} from "./history";
import { launchDetachedRun, type DetachedRunHandle, type LaunchRunRequest } from "./engine";
import {
  LIST_VIEWPORT,
  formatDetailLines,
  truncate,
  type ChromeKeyEvent,
  type PickerChrome,
} from "./chrome";
import { sanitizeDisplay, latest, type InvocationContext } from "./context";
import { runWorkbenchRoute } from "./workbench";
import type { WorkflowListEntry } from "./workflow/grammar";

const SEP = " · ";

export type RunsScope = "current" | "all";

/** Shared list/detail summary: status · display id · checkout root. */
function formatRunSummary(run: {
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

function formatRunsOptions(
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

function runsFooter(scope: RunsScope, index: number, total: number): string {
  const scopeLabel = scope === "current" ? "Current" : "All";
  const pos = total === 0 ? "0/0" : `${index + 1}/${total}`;
  return `tab workflows · ctrl+g ${scopeLabel} · enter detail · esc quit · ${pos}`;
}

function runDetailFooter(opts: { allowWorkbench?: boolean } = {}): string {
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

function viewAllowsWorkbench(view: RunDetailView): boolean {
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
  const listed = await listRuns({
    checkout_root: scope === "current" ? checkoutRoot : null,
    text: filter,
  });
  if (!listed.ok) {
    return {
      scope,
      filter,
      items: [],
      hasMachineRuns: false,
      unavailable: true,
    };
  }
  const hasMachineRuns = listed.checkout_roots.length > 0;
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
  inputValues: Record<string, string>;
  inputDomains: Record<string, string[]>;
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

type RunsBrowserScreen = {
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
  screen: RunsBrowserScreen,
  options: Parameters<PickerChrome["setOptions"]>[0],
): void {
  screen.deps.chrome.setOptions(options);
}

function stopDetailPoll(screen: RunsBrowserScreen): void {
  if (screen.detailPoll !== undefined) {
    clearInterval(screen.detailPoll);
    screen.detailPoll = undefined;
  }
}

function detachRun(screen: RunsBrowserScreen): void {
  screen.runHandle?.detach();
  screen.runHandle = undefined;
  screen.running = false;
}

/** Terminal snapshots do not poll; only live/stale snapshot detail refreshes. */
export function isDetailPollableStatus(status: string): boolean {
  return status === "running" || status === "stale";
}

function detailIsPollable(screen: RunsBrowserScreen): boolean {
  if (screen.view !== "detail") return false;
  if (!screen.activeRunId || !normalizeRunUuid(screen.activeRunId)) return false;
  if (!screen.detailView || screen.detailView.kind !== "detail") return false;
  if (screen.detailView.detail.kind !== "snapshot") return false;
  return isDetailPollableStatus(screen.detailView.detail.status);
}

function beginDetailPollRequest(
  screen: RunsBrowserScreen,
): { id: string; gen: number } | undefined {
  if (!detailIsPollable(screen)) return undefined;
  const id = screen.activeRunId!;
  return { id, gen: screen.detailToken.begin() };
}

function detailPollResponseCurrent(screen: RunsBrowserScreen, id: string, gen: number): boolean {
  return screen.view === "detail" && screen.activeRunId === id && screen.detailToken.current(gen);
}

function selectedRunSummary(screen: RunsBrowserScreen): string {
  const selected = screen.browserState?.items[screen.deps.chrome.selectedIndex()];
  if (!selected) return "";
  return formatRunSummary(selected);
}

function paintRunsSelection(screen: RunsBrowserScreen, total: number): void {
  screen.deps.chrome.setDetail(
    formatDetailLines(selectedRunSummary(screen), screen.deps.getContentWidth()),
  );
  screen.deps.chrome.setFooter(runsFooter(screen.scope, screen.deps.chrome.selectedIndex(), total));
}

function preserveSelectionId(screen: RunsBrowserScreen): string | undefined {
  return (
    screen.browserState?.selectedId ??
    screen.browserState?.items[screen.deps.chrome.selectedIndex()]?.id ??
    screen.activeRunId
  );
}

function renderDetail(screen: RunsBrowserScreen): void {
  if (!screen.detailView) return;
  const lines = detailLines(screen.detailView, screen.deps.getContentWidth());
  const { visible, scroll } = scrollDetailLines(lines, screen.detailScroll, 10);
  screen.detailScroll = scroll;
  screen.deps.chrome.showDetailLayout();
  screen.deps.chrome.status(visible.join("\n"), { flexGrow: 1 });
  screen.deps.chrome.setFooter(
    runDetailFooter({
      allowWorkbench: viewAllowsWorkbench(screen.detailView),
    }),
  );
}

async function refreshOpenDetail(screen: RunsBrowserScreen): Promise<void> {
  const req = beginDetailPollRequest(screen);
  if (!req) {
    stopDetailPoll(screen);
    return;
  }
  const view = await runDetail(req.id);
  if (!detailPollResponseCurrent(screen, req.id, req.gen)) return;
  screen.detailView = { kind: "detail", ...view };
  renderDetail(screen);
  if (!detailIsPollable(screen)) stopDetailPoll(screen);
}

function startDetailPoll(screen: RunsBrowserScreen): void {
  stopDetailPoll(screen);
  if (!detailIsPollable(screen)) return;
  const timer = setInterval(() => {
    void refreshOpenDetail(screen);
  }, 3000);
  timer.unref?.();
  screen.detailPoll = timer;
}

async function refresh(screen: RunsBrowserScreen): Promise<void> {
  if (screen.view !== "list") return;
  const gen = screen.refreshToken.begin();
  const currentScope = screen.scope;
  const filter = screen.deps.chrome.filterValue();
  const view = screen.view;
  const preserveId = preserveSelectionId(screen);
  const browser = await loadRunsBrowser(screen.deps.repoRoot, currentScope, filter, preserveId);
  if (
    !screen.refreshToken.current(gen) ||
    screen.view !== view ||
    screen.scope !== currentScope ||
    screen.deps.chrome.filterValue() !== filter
  ) {
    return;
  }
  screen.browserState = browser;
  screen.deps.chrome.showBrowser({
    filterPlaceholder: "filter runs...",
    filterValue: filter,
    showFilter: true,
    listHeight: RUNS_LIST_VIEWPORT,
  });
  screen.deps.chrome.showList("");
  if (browser.unavailable || browser.items.length === 0) {
    applyListOptions(screen, []);
    screen.deps.chrome.setDetail(
      formatDetailLines(
        formatRunListEmpty({
          scope: browser.scope,
          hasMachineRuns: browser.hasMachineRuns,
          filterActive: browser.filter.trim().length > 0,
          unavailable: browser.unavailable,
        }),
        screen.deps.getContentWidth(),
      ),
    );
    screen.deps.chrome.setFooter(runsFooter(screen.scope, 0, 0));
    return;
  }
  const options = formatRunsOptions(browser.items, screen.deps.getContentWidth(), screen.scope);
  applyListOptions(screen, options);
  const idx = runsSelectedIndex(browser.items, browser.selectedId);
  screen.deps.chrome.setSelectedIndex(idx);
  screen.browserState.selectedId = browser.items[idx]?.id;
  paintRunsSelection(screen, options.length);
}

async function enter(screen: RunsBrowserScreen): Promise<void> {
  stopDetailPoll(screen);
  const preserveFromDetail = screen.activeRunId;
  screen.running = false;
  screen.progressLines = [];
  screen.view = "list";
  screen.detailView = undefined;
  if (preserveFromDetail && screen.browserState) {
    screen.browserState.selectedId = preserveFromDetail;
  }
  screen.activeRunId = undefined;
  screen.deps.chrome.clearStatus();
  screen.deps.chrome.showBrowser({
    filterPlaceholder: "filter runs...",
    filterValue: screen.savedFilter,
    showFilter: true,
  });
  screen.deps.chrome.showList("");
  await refresh(screen);
  screen.deps.chrome.focusFilter();
}

function leave(screen: RunsBrowserScreen): void {
  stopDetailPoll(screen);
  screen.view = null;
  screen.detailView = undefined;
  screen.activeRunId = undefined;
}

async function openDetail(screen: RunsBrowserScreen, id: string): Promise<void> {
  screen.view = "detail";
  screen.activeRunId = id;
  screen.detailScroll = 0;
  const gen = screen.detailToken.begin();
  const view = await runDetail(id);
  if (screen.view !== "detail" || screen.activeRunId !== id || !screen.detailToken.current(gen)) {
    return;
  }
  screen.detailView = { kind: "detail", ...view };
  renderDetail(screen);
  startDetailPoll(screen);
}

function openSelected(screen: RunsBrowserScreen): void {
  const selected = screen.browserState?.items[screen.deps.chrome.selectedIndex()];
  if (selected) void openDetail(screen, selected.id);
}

function toggleScope(screen: RunsBrowserScreen): void {
  if (screen.view !== "list") return;
  screen.scope = screen.scope === "current" ? "all" : "current";
  void refresh(screen);
}

function onSelectionChanged(screen: RunsBrowserScreen): void {
  if (screen.view !== "list" || !screen.browserState) return;
  const selected = screen.browserState.items[screen.deps.chrome.selectedIndex()];
  if (selected) screen.browserState.selectedId = selected.id;
  screen.activeRunId = undefined;
  paintRunsSelection(screen, screen.deps.chrome.options().length);
}

function onFilterInput(screen: RunsBrowserScreen): void {
  screen.savedFilter = screen.deps.chrome.filterValue();
  void refresh(screen);
}

function onResize(screen: RunsBrowserScreen): void {
  if (screen.view === "list") void refresh(screen);
  else if (screen.view === "detail") renderDetail(screen);
}

function handleDetailKey(screen: RunsBrowserScreen, key: ChromeKeyEvent): boolean {
  if (key.name === "escape") {
    key.preventDefault();
    detachRun(screen);
    stopDetailPoll(screen);
    void enter(screen);
    return true;
  }
  if (key.name === "up") {
    key.preventDefault();
    screen.detailScroll = Math.max(0, screen.detailScroll - 1);
    renderDetail(screen);
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    screen.detailScroll += 1;
    renderDetail(screen);
    return true;
  }
  if (key.name === "w" && !key.ctrl && !key.meta) {
    key.preventDefault();
    const id = screen.activeRunId;
    if (!id || !normalizeRunUuid(id)) return true;
    if (!screen.detailView || !viewAllowsWorkbench(screen.detailView)) return true;
    stopDetailPoll(screen);
    screen.deps.launchWorkbenchRoute(runWorkbenchRoute(id));
    screen.deps.chrome.setFooter(runDetailFooter());
    return true;
  }
  return true;
}

function handleKey(screen: RunsBrowserScreen, key: ChromeKeyEvent): boolean {
  if (screen.view === "detail") return handleDetailKey(screen, key);
  if (screen.view !== "list") return false;
  if (key.ctrl && (key.name === "g" || key.sequence === "\x07")) {
    key.preventDefault();
    toggleScope(screen);
    return true;
  }
  if (key.name === "up") {
    key.preventDefault();
    screen.deps.chrome.moveUp();
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    screen.deps.chrome.moveDown();
    return true;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    openSelected(screen);
    return true;
  }
  return false;
}

function setStartingDetail(
  screen: RunsBrowserScreen,
  entry: WorkflowListEntry,
  runId: string,
): void {
  stopDetailPoll(screen);
  screen.view = "detail";
  screen.running = true;
  screen.activeRunId = runId;
  screen.detailScroll = 0;
  screen.progressLines = [];
  screen.detailToken.begin();
  screen.detailView = { kind: "starting", id: runId, workflow: entry.name };
  renderDetail(screen);
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
  screen: RunsBrowserScreen,
  launch: StartRunLaunch,
  runId: string,
): boolean {
  return Boolean(launch.getExit()) || screen.view !== "detail" || screen.activeRunId !== runId;
}

function withProgress(
  screen: RunsBrowserScreen,
  runId: string,
  entry: WorkflowListEntry,
  checkoutRoot: string,
  historyState: "pending" | "claimed" | "unavailable",
): void {
  if (screen.detailView?.kind === "detail" || screen.detailView?.kind === "history-unavailable") {
    screen.detailView = { ...screen.detailView, progress: screen.progressLines };
  } else if (screen.detailView?.kind === "starting" && historyState === "claimed") {
    screen.detailView = runningDetailView(runId, entry, checkoutRoot, screen.progressLines);
  }
}

async function startRun(
  screen: RunsBrowserScreen,
  entry: WorkflowListEntry,
  launch: StartRunLaunch,
): Promise<void> {
  const inputs = Object.fromEntries(
    Object.entries(launch.inputValues).map(([key, value]) => [key, sanitizeDisplay(value)]),
  );
  const runId = allocateRunId();
  const checkoutRoot = await canonicalRepoRoot(screen.deps.repoRoot);
  setStartingDetail(screen, entry, runId);
  try {
    const launchFn = launch.launchRun ?? launchDetachedRun;
    const history = { state: "pending" as "pending" | "claimed" | "unavailable" };
    const handle = launchFn({
      name: entry.name,
      repoRoot: screen.deps.repoRoot,
      ctx: launch.ctx,
      inputs,
      domains: launch.inputDomains,
      runId,
      onHistoryAck: (line) => {
        if (launchCancelled(screen, launch, runId)) return;
        const ack = parseHistoryAck(line);
        if (!ack) return;
        if (ack.state === "claimed" && ack.id === runId) {
          history.state = "claimed";
          screen.detailView = runningDetailView(runId, entry, checkoutRoot, screen.progressLines);
          renderDetail(screen);
          startDetailPoll(screen);
          return;
        }
        if (ack.state === "unavailable") {
          history.state = "unavailable";
          stopDetailPoll(screen);
          screen.detailView = {
            kind: "history-unavailable",
            id: runId,
            workflow: entry.name,
            progress: screen.progressLines,
          };
          renderDetail(screen);
        }
      },
      onProgressLine: (line) => {
        if (launchCancelled(screen, launch, runId)) return;
        const progress = parseProgressLine(line);
        if (!progress) return;
        screen.progressLines.push(
          truncate(formatProgressLine(progress), screen.deps.getContentWidth()),
        );
        withProgress(screen, runId, entry, checkoutRoot, history.state);
        renderDetail(screen);
      },
    });
    screen.runHandle = handle;
    const result = await handle.result;
    if (launchCancelled(screen, launch, runId)) return;
    screen.runHandle = undefined;
    screen.running = false;
    stopDetailPoll(screen);
    if (history.state === "pending" && !result.ok) {
      screen.detailView = {
        kind: "local-failure",
        id: runId,
        workflow: entry.name,
        message: result.detail || "launch failed",
      };
      renderDetail(screen);
      return;
    }
    if (history.state === "unavailable") {
      screen.detailView = {
        kind: "history-unavailable",
        id: runId,
        workflow: entry.name,
        progress: screen.progressLines,
        finished: result.ok ? "succeeded" : "failed",
        ...(result.ok ? {} : { message: result.detail }),
      };
      renderDetail(screen);
      return;
    }
    const gen = screen.detailToken.begin();
    const view = await runDetail(runId);
    if (
      screen.view !== "detail" ||
      screen.activeRunId !== runId ||
      !screen.detailToken.current(gen)
    ) {
      return;
    }
    screen.detailView = { kind: "detail", ...view };
    renderDetail(screen);
    startDetailPoll(screen);
  } catch (error) {
    screen.runHandle = undefined;
    screen.running = false;
    stopDetailPoll(screen);
    screen.detailView = {
      kind: "local-failure",
      id: runId,
      workflow: entry.name,
      message: error instanceof Error ? error.message : String(error),
    };
    renderDetail(screen);
  }
}

export function createRunsBrowser(deps: RunsBrowserDeps): RunsBrowser {
  const screen: RunsBrowserScreen = {
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
    enter: () => enter(screen),
    leave: () => leave(screen),
    handleKey: (key) => handleKey(screen, key),
    dispose: () => {
      detachRun(screen);
      stopDetailPoll(screen);
      screen.view = null;
    },
    refresh: () => refresh(screen),
    onSelectionChanged: () => onSelectionChanged(screen),
    onFilterInput: () => onFilterInput(screen),
    onResize: () => onResize(screen),
    startRun: (entry, launch) => startRun(screen, entry, launch),
    openDetail: (id) => openDetail(screen, id),
    openSelected: () => openSelected(screen),
    isActive: () => screen.view !== null,
    isDetail: () => screen.view === "detail",
    get running() {
      return screen.running;
    },
  };
}
