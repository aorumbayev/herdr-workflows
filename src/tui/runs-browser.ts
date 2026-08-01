import { sanitizeDisplay, type InvocationContext, type WorkflowsConfig } from "../context";
import {
  allocateRunId,
  canonicalRepoRoot,
  normalizeRunUuid,
  optimisticRunningDetail,
  parseHistoryAck,
  presentDetail,
  runDetail,
} from "../history";
import { latest } from "../context";
import type { LoadedWorkflow, WorkflowListEntry } from "../workflow/types";
import { runWorkbenchRoute } from "../workbench";
import { LIST_VIEWPORT, type ChromeKeyEvent, type PickerChrome } from "./picker-chrome";
import { formatDetailLines, truncate } from "./picker-rows";
import {
  detailLines,
  formatRunListEmpty,
  formatRunSummary,
  formatRunsOptions,
  loadRunsBrowser,
  runDetailFooter,
  runsFooter,
  viewAllowsWorkbench,
  type RunDetailView,
  type RunsBrowserState,
  type RunsScope,
} from "./run-history";
import { launchDetachedRun, type DetachedRunHandle, type LaunchRunRequest } from "../engine";

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
