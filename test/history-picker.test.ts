import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunRow, formatRunListEmpty } from "../src/history/format";
import { allocateRunId, RunHistorySession } from "../src/history/store";
import type { RunListItem } from "../src/history/types";
import { runWorkbenchRoute } from "../src/web/route";
import {
  applyRunsListViewport,
  detailLines,
  loadRunDetailView,
  loadRunsBrowser,
  runsSelectedIndex,
  scrollDetailLines,
} from "../src/tui/run-history-view";
import {
  beginDetailPollRequest,
  detailPollResponseCurrent,
  openRunDetail,
  refreshRunsBrowser,
  setRunsMode,
  stopDetailPoll,
  type RunsChrome,
} from "../src/tui/picker-runs";
import {
  pickerEscapeExitCode,
  shouldDropStdinLeakSequence,
  type PickerState,
} from "../src/tui/picker";

const dirs: string[] = [];
let prevState: string | undefined;

beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "hwf-hist-pick-"));
  dirs.push(state);
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function item(partial: Partial<RunListItem> & Pick<RunListItem, "id" | "workflow">): RunListItem {
  return {
    display_id: partial.id.slice(0, 8),
    source: "repo",
    checkout_root: "/repo",
    status: "succeeded",
    started_at: new Date().toISOString(),
    elapsed_ms: 1200,
    ...partial,
  };
}

function mockRunsState(repoRoot: string): PickerState {
  let selected = 0;
  let options: { name: string; description: string; value: { run: RunListItem } }[] = [];
  return {
    mode: "runs",
    entries: [],
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    inputDomains: {},
    resolveGeneration: 0,
    choiceOptions: [],
    customChoice: false,
    running: false,
    progressLines: [],
    repoRoot,
    config: { profiles: {}, default_profile: "", transcripts: {} },
    ctx: { selection: "", cwd: repoRoot },
    loadWorkflow: async () => {
      throw new Error("unused");
    },
    reloadEntries: async () => [],
    contentWidth: 80,
    theme: {} as PickerState["theme"],
    renderer: {} as PickerState["renderer"],
    filterRow: { visible: true } as PickerState["filterRow"],
    filter: {
      value: "",
      placeholder: "",
      visible: true,
      focus: () => undefined,
    } as PickerState["filter"],
    updateHint: {} as PickerState["updateHint"],
    listBlock: {} as PickerState["listBlock"],
    list: {
      // Deliberately wrong — production refresh must apply the viewport seam.
      height: 99,
      get options() {
        return options;
      },
      set options(next) {
        options = next as typeof options;
      },
      getSelectedIndex: () => selected,
      setSelectedIndex: (i: number) => {
        selected = i;
      },
      focus: () => undefined,
    } as PickerState["list"],
    status: { visible: false, content: "", flexGrow: 0 } as unknown as PickerState["status"],
    detail: { content: "" } as unknown as PickerState["detail"],
    rule: { content: "" } as unknown as PickerState["rule"],
    promptInput: { value: "" } as unknown as PickerState["promptInput"],
    footer: { content: "" } as unknown as PickerState["footer"],
    runsScope: "current",
    savedWorkflowFilter: "",
    savedRunsFilter: "",
    runDetailScroll: 0,
  };
}

function chromeStub(): RunsChrome {
  return {
    truncate: (t) => t,
    formatDetailLines: (t) => t,
    setListOptions: (state, options) => {
      state.list.options = options;
    },
    showBrowserChrome: (state) => {
      applyRunsListViewport(state.list);
    },
    showListChrome: () => undefined,
    hideBrowserChrome: () => undefined,
    hideListChrome: () => undefined,
    hideUpdateHint: () => undefined,
    showStatus: () => undefined,
    launchWorkbenchRoute: () => undefined,
  };
}

describe("picker run history formatting", () => {
  test("refresh applies production viewport and routes cursor to selected run", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-view-"));
    dirs.push(root);
    await mkdir(root, { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const session = new RunHistorySession();
      await session.claim({
        workflow: `wf-${i}`,
        source: "repo",
        checkout_root: root,
        started_at: new Date(Date.now() - i * 1000).toISOString(),
      });
      ids.push(session.id!);
      await session.finalize("succeeded");
      session.dispose();
    }
    const keep = ids[7]!;
    const state = mockRunsState(root);
    expect(state.list.height).toBe(99);
    state.runsState = {
      scope: "current",
      filter: "",
      items: [],
      selectedId: keep,
      hasMachineRuns: true,
      unavailable: false,
    };
    await refreshRunsBrowser(state, chromeStub());
    const applied = applyRunsListViewport({ height: 0 });
    expect(state.list.height).toBe(applied);
    expect(state.list.options.length).toBe(8);
    const idx = runsSelectedIndex(
      state.list.options.map((o) => o.value.run),
      keep,
    );
    expect(state.list.getSelectedIndex()).toBe(idx);
    expect(state.list.options[idx]!.value.run.id).toBe(keep);
    expect(state.runsState?.selectedId).toBe(keep);
  });

  test("overlapping detail poll generations reject older responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-gen-"));
    dirs.push(root);
    const session = new RunHistorySession();
    await session.claim({ workflow: "live", source: "repo", checkout_root: root });
    const id = session.id!;
    // Keep non-terminal so detail is pollable.
    const state = mockRunsState(root);
    state.mode = "run-detail";
    state.activeRunId = id;
    state.runDetailView = {
      kind: "detail",
      detail: {
        kind: "snapshot",
        id,
        display_id: id.slice(0, 8),
        workflow: "live",
        source: "repo",
        checkout_root: root,
        status: "running",
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        elapsed_ms: 0,
        steps: [],
      },
    };
    const first = beginDetailPollRequest(state);
    expect(first).toEqual({ id, gen: 1 });
    const second = beginDetailPollRequest(state);
    expect(second).toEqual({ id, gen: 2 });
    expect(detailPollResponseCurrent(state, first!.id, first!.gen)).toBe(false);
    expect(detailPollResponseCurrent(state, second!.id, second!.gen)).toBe(true);
    session.dispose();
  });

  test("empty states distinguish current, machine, and filter miss", () => {
    expect(
      formatRunListEmpty({ scope: "current", hasMachineRuns: true, filterActive: false }),
    ).toContain("Ctrl+G");
    expect(
      formatRunListEmpty({ scope: "all", hasMachineRuns: false, filterActive: false }),
    ).toContain("no workflow has run yet");
    expect(formatRunListEmpty({ scope: "current", hasMachineRuns: true, filterActive: true })).toBe(
      "no matching runs",
    );
  });

  test("detail scroll keeps a fixed viewport", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const first = scrollDetailLines(lines, 0, 6);
    expect(first.visible).toHaveLength(6);
    const next = scrollDetailLines(lines, 3, 6);
    expect(next.visible[0]).toBe("line 3");
    expect(next.scroll).toBe(3);
  });

  test("Ctrl+G raw byte is preserved for OpenTUI", () => {
    expect(shouldDropStdinLeakSequence("\x07")).toBe(false);
  });

  test("escape while running detail detaches with zero", () => {
    expect(pickerEscapeExitCode("run-detail", true)).toBe(0);
    expect(pickerEscapeExitCode("run-detail", false)).toBe(1);
  });

  test("workbench route uses complete UUID", () => {
    const id = allocateRunId();
    expect(runWorkbenchRoute(id)).toBe(`run=${id}`);
  });

  test("loadRunsBrowser preserves selection when returning from detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-root-"));
    dirs.push(root);
    await mkdir(root, { recursive: true });
    const first = new RunHistorySession();
    await first.claim({ workflow: "one", source: "repo", checkout_root: root });
    await first.finalize("succeeded");
    const keep = first.id!;
    first.dispose();
    await Bun.sleep(5);
    const second = new RunHistorySession();
    await second.claim({ workflow: "two", source: "repo", checkout_root: root });
    await second.finalize("succeeded");
    second.dispose();

    const browser = await loadRunsBrowser(root, "current", "", keep);
    expect(browser.selectedId).toBe(keep);
    expect(browser.items.some((r) => r.id === keep)).toBe(true);
  });

  test("loadRunsBrowser scopes current exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-root-"));
    dirs.push(root);
    await mkdir(root, { recursive: true });
    const local = new RunHistorySession();
    await local.claim({ workflow: "here", source: "repo", checkout_root: root });
    await local.finalize("succeeded");
    local.dispose();
    const foreignRoot = await mkdtemp(join(tmpdir(), "hwf-foreign-"));
    dirs.push(foreignRoot);
    const foreignOk = new RunHistorySession();
    await foreignOk.claim({
      workflow: "there",
      source: "repo",
      checkout_root: foreignRoot,
    });
    await foreignOk.finalize("succeeded");
    foreignOk.dispose();

    const current = await loadRunsBrowser(root, "current", "");
    const canonical = await realpath(root);
    expect(current.items.every((r) => r.checkout_root === canonical)).toBe(true);
    const all = await loadRunsBrowser(root, "all", "");
    expect(all.items.length).toBeGreaterThanOrEqual(2);
  });

  test("non-UUID detail ids are invalid not legacy summaries", async () => {
    const view = await loadRunDetailView("not-a-uuid");
    expect(view.kind).toBe("detail");
    if (view.kind !== "detail") return;
    expect(view.detail.kind).toBe("invalid");
  });

  test("return to runs clears activeRunId and preserves selectedId", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-active-"));
    dirs.push(root);
    const session = new RunHistorySession();
    await session.claim({ workflow: "keep", source: "repo", checkout_root: root });
    await session.finalize("succeeded");
    const keep = session.id!;
    session.dispose();
    const state = mockRunsState(root);
    await refreshRunsBrowser(state, chromeStub());
    state.activeRunId = keep;
    state.mode = "run-detail";
    await setRunsMode(state, chromeStub());
    expect(state.mode as string).toBe("runs");
    expect(state.activeRunId).toBeUndefined();
    expect(state.runsState?.selectedId).toBe(keep);
  });

  test("detail poll stops for terminal snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-poll-"));
    dirs.push(root);
    const session = new RunHistorySession();
    await session.claim({ workflow: "done", source: "repo", checkout_root: root });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();
    const state = mockRunsState(root);
    await refreshRunsBrowser(state, chromeStub());
    await openRunDetail(state, id, chromeStub());
    expect(state.runDetailPoll).toBeUndefined();
    stopDetailPoll(state);
  });

  test("starting detail lines are distinct from failure", () => {
    const id = allocateRunId();
    const starting = detailLines({ kind: "starting", id, workflow: "demo" }, 80);
    expect(starting[0]).toContain("STARTING");
    const unavailable = detailLines(
      {
        kind: "history-unavailable",
        id,
        workflow: "demo",
        progress: ["[1/1] shell"],
        finished: "succeeded",
      },
      80,
    );
    expect(unavailable[0]).toContain("HISTORY UNAVAILABLE");
    expect(unavailable[0]).toContain("SUCCEEDED");
  });

  test("narrow truncation keeps status", () => {
    const row = item({
      id: allocateRunId(),
      workflow: "workflow-with-a-very-long-name",
      status: "interrupted",
    });
    const narrow = formatRunRow(row, 20);
    expect(narrow).toMatch(/INTERRUPTED|INTR|I/);
    expect(narrow.length).toBeLessThanOrEqual(24);
  });
});
