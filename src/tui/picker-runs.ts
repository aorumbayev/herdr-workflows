import type { KeyEvent, SelectOption } from "@opentui/core";
import { parseHistoryAck } from "../history/ack";
import { allocateRunId } from "../history/store";
import { normalizeRunUuid, statusLabel } from "../history/project";
import { sanitizeDisplay } from "../herdr";
import { runWorkbenchRoute } from "../web/route";
import type { WorkflowListEntry } from "../workflow/types";
import type { PickerState } from "./picker";
import {
  applyRunsListViewport,
  detailLines,
  formatRunsOptions,
  loadRunDetailView,
  loadRunsBrowser,
  runDetailFooter,
  runsEmptyMessage,
  runsFooter,
  runsSelectedIndex,
  scrollDetailLines,
} from "./run-history-view";
import { launchDetachedRun } from "./run-launch";

export type RunsChrome = {
  truncate: (text: string, max: number) => string;
  formatDetailLines: (description: string, contentWidth: number) => string;
  setListOptions: (state: PickerState, options: SelectOption[]) => void;
  showBrowserChrome: (state: PickerState) => void;
  showListChrome: (state: PickerState) => void;
  hideBrowserChrome: (state: PickerState) => void;
  hideListChrome: (state: PickerState) => void;
  hideUpdateHint: (state: PickerState) => void;
  showStatus: (
    state: PickerState,
    content: string,
    options?: { flexGrow?: number; warn?: boolean },
  ) => void;
  launchWorkbenchRoute: (state: PickerState, route: string) => void;
};

function selectedRunSummary(state: PickerState): string {
  const selected = state.runsState?.items[state.list.getSelectedIndex()];
  if (!selected) return "";
  return [statusLabel(selected.status), selected.display_id, selected.checkout_root].join(" · ");
}

function preserveRunsSelectionId(state: PickerState): string | undefined {
  return (
    state.runsState?.selectedId ??
    state.runsState?.items[state.list.getSelectedIndex()]?.id ??
    state.activeRunId
  );
}

export function stopDetailPoll(state: PickerState): void {
  if (state.runDetailPoll !== undefined) {
    clearInterval(state.runDetailPoll);
    state.runDetailPoll = undefined;
  }
}

function detailIsPollable(state: PickerState): boolean {
  if (state.mode !== "run-detail") return false;
  const id = state.activeRunId;
  if (!id || !normalizeRunUuid(id)) return false;
  const view = state.runDetailView;
  if (!view || view.kind !== "detail") return false;
  if (view.detail.kind !== "snapshot") return false;
  return view.detail.status === "running" || view.detail.status === "stale";
}

/** Bump per in-flight detail request so older overlapping polls cannot apply. */
export function beginDetailPollRequest(
  state: PickerState,
): { id: string; gen: number } | undefined {
  if (!detailIsPollable(state)) return undefined;
  const id = state.activeRunId!;
  state.runDetailGeneration = (state.runDetailGeneration ?? 0) + 1;
  return { id, gen: state.runDetailGeneration };
}

export function detailPollResponseCurrent(state: PickerState, id: string, gen: number): boolean {
  return (
    state.mode === "run-detail" &&
    state.activeRunId === id &&
    gen === (state.runDetailGeneration ?? 0)
  );
}

async function refreshOpenRunDetail(state: PickerState, chrome: RunsChrome): Promise<void> {
  const req = beginDetailPollRequest(state);
  if (!req) {
    stopDetailPoll(state);
    return;
  }
  const view = await loadRunDetailView(req.id);
  if (!detailPollResponseCurrent(state, req.id, req.gen)) return;
  state.runDetailView = view;
  renderRunDetail(state, chrome);
  if (!detailIsPollable(state)) stopDetailPoll(state);
}

function startDetailPoll(state: PickerState, chrome: RunsChrome): void {
  stopDetailPoll(state);
  if (!detailIsPollable(state)) return;
  const timer = setInterval(() => {
    void refreshOpenRunDetail(state, chrome);
  }, 3000);
  timer.unref?.();
  state.runDetailPoll = timer;
}

export async function refreshRunsBrowser(state: PickerState, chrome: RunsChrome): Promise<void> {
  const gen = (state.runsRefreshGeneration = (state.runsRefreshGeneration ?? 0) + 1);
  const scope = state.runsScope;
  const filter = state.filter.value;
  const mode = state.mode;
  const preserveId = preserveRunsSelectionId(state);
  const browser = await loadRunsBrowser(state.repoRoot, scope, filter, preserveId);
  if (
    gen !== state.runsRefreshGeneration ||
    state.mode !== mode ||
    state.runsScope !== scope ||
    state.filter.value !== filter
  ) {
    return;
  }
  state.runsState = browser;
  applyRunsListViewport(state.list);
  if (browser.unavailable || browser.items.length === 0) {
    chrome.setListOptions(state, []);
    state.detail.content = chrome.formatDetailLines(runsEmptyMessage(browser), state.contentWidth);
    state.footer.content = runsFooter(state.runsScope, 0, 0);
    return;
  }
  const options = formatRunsOptions(browser.items, state.contentWidth, state.runsScope);
  chrome.setListOptions(state, options);
  const idx = runsSelectedIndex(browser.items, browser.selectedId);
  state.list.setSelectedIndex(idx);
  state.runsState.selectedId = browser.items[idx]?.id;
  state.detail.content = chrome.formatDetailLines(selectedRunSummary(state), state.contentWidth);
  state.footer.content = runsFooter(state.runsScope, state.list.getSelectedIndex(), options.length);
}

export async function setRunsMode(state: PickerState, chrome: RunsChrome): Promise<void> {
  stopDetailPoll(state);
  const preserveFromDetail = state.activeRunId;
  state.savedWorkflowFilter = state.filter.value;
  state.mode = "runs";
  state.pending = undefined;
  state.workflow = undefined;
  state.runDetailView = undefined;
  state.running = false;
  state.progressLines = [];
  if (preserveFromDetail && state.runsState) {
    state.runsState.selectedId = preserveFromDetail;
  }
  state.activeRunId = undefined;
  chrome.showBrowserChrome(state);
  state.filter.placeholder = "filter runs...";
  state.filter.value = state.savedRunsFilter;
  state.filterRow.visible = true;
  state.filter.visible = true;
  chrome.showListChrome(state);
  state.status.visible = false;
  state.status.content = "";
  state.status.flexGrow = 0;
  chrome.hideUpdateHint(state);
  await refreshRunsBrowser(state, chrome);
  state.filter.focus();
}

export function renderRunDetail(state: PickerState, chrome: RunsChrome): void {
  if (!state.runDetailView) return;
  const lines = detailLines(state.runDetailView, state.contentWidth);
  const { visible, scroll } = scrollDetailLines(lines, state.runDetailScroll, 10);
  state.runDetailScroll = scroll;
  chrome.hideBrowserChrome(state);
  chrome.hideListChrome(state);
  chrome.showStatus(state, visible.join("\n"), { flexGrow: 1 });
  const allowWorkbench =
    state.runDetailView.kind !== "history-unavailable" &&
    state.runDetailView.kind !== "local-failure" &&
    state.runDetailView.kind !== "starting";
  state.footer.content = runDetailFooter({ allowWorkbench });
}

export async function openRunDetail(
  state: PickerState,
  id: string,
  chrome: RunsChrome,
): Promise<void> {
  state.mode = "run-detail";
  state.activeRunId = id;
  state.runDetailScroll = 0;
  state.runDetailGeneration = (state.runDetailGeneration ?? 0) + 1;
  const gen = state.runDetailGeneration;
  const view = await loadRunDetailView(id);
  if (
    state.mode !== "run-detail" ||
    state.activeRunId !== id ||
    gen !== state.runDetailGeneration
  ) {
    return;
  }
  state.runDetailView = view;
  renderRunDetail(state, chrome);
  startDetailPoll(state, chrome);
}

export function toggleRunsScope(state: PickerState, chrome: RunsChrome): void {
  if (state.mode !== "runs") return;
  state.runsScope = state.runsScope === "current" ? "all" : "current";
  void refreshRunsBrowser(state, chrome);
}

function setStartingDetail(
  state: PickerState,
  entry: WorkflowListEntry,
  runId: string,
  chrome: RunsChrome,
): void {
  stopDetailPoll(state);
  state.mode = "run-detail";
  state.running = true;
  state.activeRunId = runId;
  state.runDetailScroll = 0;
  state.progressLines = [];
  state.runDetailGeneration = (state.runDetailGeneration ?? 0) + 1;
  state.runDetailView = { kind: "starting", id: runId, workflow: entry.name };
  renderRunDetail(state, chrome);
}

function runningDetail(
  runId: string,
  entry: WorkflowListEntry,
  checkoutRoot: string,
  progress: string[],
): NonNullable<PickerState["runDetailView"]> {
  const now = new Date().toISOString();
  return {
    kind: "detail",
    detail: {
      kind: "snapshot",
      id: runId,
      display_id: runId.slice(0, 8),
      workflow: entry.name,
      source: entry.source,
      checkout_root: checkoutRoot,
      status: "running",
      started_at: now,
      heartbeat_at: now,
      elapsed_ms: 0,
      steps: [],
    },
    progress,
  };
}

export function handleRunDetailKey(state: PickerState, key: KeyEvent, chrome: RunsChrome): void {
  if (key.name === "escape") {
    key.preventDefault();
    state.runHandle?.detach();
    state.runHandle = undefined;
    state.running = false;
    stopDetailPoll(state);
    void setRunsMode(state, chrome);
    return;
  }
  if (key.name === "up") {
    key.preventDefault();
    state.runDetailScroll = Math.max(0, state.runDetailScroll - 1);
    renderRunDetail(state, chrome);
    return;
  }
  if (key.name === "down") {
    key.preventDefault();
    state.runDetailScroll += 1;
    renderRunDetail(state, chrome);
    return;
  }
  if (key.name === "w" && !key.ctrl && !key.meta) {
    key.preventDefault();
    const id = state.activeRunId;
    if (!id || !normalizeRunUuid(id)) return;
    if (
      state.runDetailView?.kind === "history-unavailable" ||
      state.runDetailView?.kind === "local-failure" ||
      state.runDetailView?.kind === "starting"
    ) {
      return;
    }
    stopDetailPoll(state);
    chrome.launchWorkbenchRoute(state, runWorkbenchRoute(id));
    if (!state.exit) state.footer.content = runDetailFooter();
  }
}

export function updateRunsSelectionChrome(state: PickerState, chrome: RunsChrome): void {
  if (state.mode !== "runs" || !state.runsState) return;
  const selected = state.runsState.items[state.list.getSelectedIndex()];
  if (selected) state.runsState.selectedId = selected.id;
  state.activeRunId = undefined;
  state.detail.content = chrome.formatDetailLines(selectedRunSummary(state), state.contentWidth);
  state.footer.content = runsFooter(
    state.runsScope,
    state.list.getSelectedIndex(),
    state.list.options.length,
  );
}

export async function startRun(
  state: PickerState,
  entry: WorkflowListEntry,
  chrome: RunsChrome,
): Promise<void> {
  const inputs = Object.fromEntries(
    Object.entries(state.inputValues).map(([key, value]) => [key, sanitizeDisplay(value)]),
  );
  const runId = allocateRunId();
  setStartingDetail(state, entry, runId, chrome);
  try {
    state.workflow =
      state.workflow ?? (await state.loadWorkflow(entry, state.repoRoot, state.config));
    const launch = state.launchRun ?? launchDetachedRun;
    const history = { state: "pending" as "pending" | "claimed" | "unavailable" };
    const handle = launch({
      name: entry.name,
      repoRoot: state.repoRoot,
      ctx: state.ctx,
      inputs,
      domains: state.inputDomains,
      runId,
      onHistoryAck: (line) => {
        if (state.exit || state.mode !== "run-detail" || state.activeRunId !== runId) return;
        const ack = parseHistoryAck(line);
        if (!ack) return;
        if (ack.state === "claimed" && ack.id === runId) {
          history.state = "claimed";
          state.runDetailView = runningDetail(runId, entry, state.repoRoot, state.progressLines);
          renderRunDetail(state, chrome);
          startDetailPoll(state, chrome);
          return;
        }
        if (ack.state === "unavailable") {
          history.state = "unavailable";
          stopDetailPoll(state);
          state.runDetailView = {
            kind: "history-unavailable",
            id: runId,
            workflow: entry.name,
            progress: state.progressLines,
          };
          renderRunDetail(state, chrome);
        }
      },
      onProgressLine: (line) => {
        if (state.exit || state.mode !== "run-detail" || state.activeRunId !== runId) return;
        state.progressLines.push(chrome.truncate(line, state.contentWidth));
        if (state.runDetailView?.kind === "detail") {
          state.runDetailView = { ...state.runDetailView, progress: state.progressLines };
        } else if (state.runDetailView?.kind === "history-unavailable") {
          state.runDetailView = { ...state.runDetailView, progress: state.progressLines };
        } else if (state.runDetailView?.kind === "starting" && history.state === "claimed") {
          state.runDetailView = runningDetail(runId, entry, state.repoRoot, state.progressLines);
        }
        renderRunDetail(state, chrome);
      },
    });
    state.runHandle = handle;
    const result = await handle.result;
    if (state.exit || state.mode !== "run-detail" || state.activeRunId !== runId) return;
    state.runHandle = undefined;
    state.running = false;
    stopDetailPoll(state);
    if (history.state === "pending" && !result.ok) {
      state.runDetailView = {
        kind: "local-failure",
        id: runId,
        workflow: entry.name,
        message: result.detail || "launch failed",
      };
      renderRunDetail(state, chrome);
      return;
    }
    if (history.state === "unavailable") {
      state.runDetailView = {
        kind: "history-unavailable",
        id: runId,
        workflow: entry.name,
        progress: state.progressLines,
        finished: result.ok ? "succeeded" : "failed",
        ...(result.ok ? {} : { message: result.detail }),
      };
      renderRunDetail(state, chrome);
      return;
    }
    const gen = (state.runDetailGeneration = (state.runDetailGeneration ?? 0) + 1);
    const view = await loadRunDetailView(runId);
    if (
      state.mode !== "run-detail" ||
      state.activeRunId !== runId ||
      gen !== state.runDetailGeneration
    ) {
      return;
    }
    state.runDetailView = view;
    renderRunDetail(state, chrome);
    startDetailPoll(state, chrome);
  } catch (error) {
    state.runHandle = undefined;
    state.running = false;
    stopDetailPoll(state);
    state.runDetailView = {
      kind: "local-failure",
      id: runId,
      workflow: entry.name,
      message: error instanceof Error ? error.message : String(error),
    };
    renderRunDetail(state, chrome);
  }
}
