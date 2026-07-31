import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allocateRunId, RunHistorySession, getRunDetail } from "../src/history/store";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRunRow,
  formatRunListEmpty,
  detailLines,
  loadRunsBrowser,
} from "../src/tui/run-history";
import type { RunListItem } from "../src/history/types";
import { runWorkbenchRoute } from "../src/web/endpoint";
import {
  createRunsBrowser,
  RUNS_LIST_VIEWPORT,
  runsSelectedIndex,
  scrollDetailLines,
  type RunsBrowser,
  type RunsBrowserDeps,
} from "../src/tui/runs-browser";
import { pickerEscapeExitCode, shouldDropStdinLeakSequence } from "../src/tui/picker";

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

type FakeList = {
  height: number;
  options: { name: string; description: string; value: { run: RunListItem } }[];
  getSelectedIndex: () => number;
  setSelectedIndex: (i: number) => void;
  focus: () => void;
};

function fakeList(): FakeList {
  let selected = 0;
  let options: FakeList["options"] = [];
  return {
    height: 99,
    get options() {
      return options;
    },
    set options(next) {
      options = next;
    },
    getSelectedIndex: () => selected,
    setSelectedIndex: (i: number) => {
      selected = i;
    },
    focus: () => undefined,
  };
}

function fakeText(content = ""): { content: string; visible: boolean } {
  return { content, visible: true };
}

function fakeFilter(): {
  value: string;
  placeholder: string;
  visible: boolean;
  focus: () => void;
} {
  return {
    value: "",
    placeholder: "",
    visible: true,
    focus: () => undefined,
  };
}

function createTestRuns(repoRoot: string): {
  runs: RunsBrowser;
  list: FakeList;
  mode: { current: string };
  status: { content: string };
  footer: { content: string };
} {
  const list = fakeList();
  const detail = fakeText();
  const footer = fakeText();
  const filter = fakeFilter();
  const filterRow = { visible: true };
  const mode = { current: "runs" };
  const status = { content: "" };
  const deps: RunsBrowserDeps = {
    repoRoot,
    getContentWidth: () => 80,
    list,
    detail,
    footer,
    filter,
    filterRow,
    showBrowserChrome: () => {
      list.height = RUNS_LIST_VIEWPORT;
    },
    showListChrome: () => undefined,
    hideBrowserChrome: () => undefined,
    hideListChrome: () => undefined,
    hideUpdateHint: () => undefined,
    showStatus: (content) => {
      status.content = content;
    },
    hideStatus: () => undefined,
    setListOptions: (options) => {
      list.options = options as FakeList["options"];
    },
    formatDetailLines: (t) => t,
    truncate: (t) => t,
    launchWorkbenchRoute: () => undefined,
    setMode: (next) => {
      mode.current = next;
    },
    getMode: () => mode.current,
  };
  return { runs: createRunsBrowser(deps), list, mode, status, footer };
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
    const { runs, list } = createTestRuns(root);
    expect(list.height).toBe(99);
    await runs.refresh();
    expect(list.height).toBe(RUNS_LIST_VIEWPORT);
    const keepIdx = runsSelectedIndex(
      list.options.map((o) => o.value.run),
      keep,
    );
    list.setSelectedIndex(keepIdx);
    runs.onSelectionChanged();
    await runs.refresh();
    expect(list.options.length).toBe(8);
    const idx = runsSelectedIndex(
      list.options.map((o) => o.value.run),
      keep,
    );
    expect(list.getSelectedIndex()).toBe(idx);
    expect(list.options[idx]!.value.run.id).toBe(keep);
  });

  test("overlapping detail opens keep the latest status content", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-gen-"));
    dirs.push(root);
    const first = new RunHistorySession();
    await first.claim({ workflow: "one", source: "repo", checkout_root: root });
    await first.finalize("succeeded");
    const firstId = first.id!;
    first.dispose();
    await Bun.sleep(5);
    const second = new RunHistorySession();
    await second.claim({ workflow: "two", source: "repo", checkout_root: root });
    await second.finalize("succeeded");
    const secondId = second.id!;
    second.dispose();
    const { runs, mode, status } = createTestRuns(root);
    mode.current = "run-detail";
    const older = runs.openDetail(firstId);
    await runs.openDetail(secondId);
    await older;
    expect(String(status.content)).toContain("two");
    expect(String(status.content)).not.toContain("one");
    runs.dispose();
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
    const detail = await getRunDetail("not-a-uuid");
    expect(detail.kind).toBe("invalid");
  });

  test("return to runs preserves list selection from the open detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-active-"));
    dirs.push(root);
    const session = new RunHistorySession();
    await session.claim({ workflow: "keep", source: "repo", checkout_root: root });
    await session.finalize("succeeded");
    const keep = session.id!;
    session.dispose();
    const { runs, mode, list } = createTestRuns(root);
    await runs.refresh();
    mode.current = "run-detail";
    await runs.openDetail(keep);
    await runs.enter();
    expect(mode.current).toBe("runs");
    const idx = list.getSelectedIndex();
    expect(list.options[idx]!.value.run.id).toBe(keep);
  });

  test("terminal detail shows succeeded without further poll updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-poll-"));
    dirs.push(root);
    const session = new RunHistorySession();
    await session.claim({ workflow: "done", source: "repo", checkout_root: root });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();
    const { runs, status } = createTestRuns(root);
    await runs.refresh();
    await runs.openDetail(id);
    const first = String(status.content);
    expect(first).toContain("SUCCEEDED");
    await Bun.sleep(10);
    expect(String(status.content)).toBe(first);
    runs.dispose();
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
