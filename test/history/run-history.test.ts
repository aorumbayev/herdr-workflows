import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allocateRunId, RunHistorySession, runDetail } from "../../src/history/store";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRunRow,
  formatRunListEmpty,
  detailLines,
  loadRunsBrowser,
} from "../../src/tui/run-history";
import type { RunListItem } from "../../src/history/types";
import { runWorkbenchRoute } from "../../src/web/endpoint";
import {
  createRunsBrowser,
  isDetailPollableStatus,
  RUNS_LIST_VIEWPORT,
  runsSelectedIndex,
  scrollDetailLines,
  type RunsBrowser,
  type RunsBrowserDeps,
} from "../../src/tui/runs-browser";
import { pickerEscapeExitCode, shouldDropStdinLeakSequence } from "../../src/tui/picker-actions";
import { fakePickerChrome, type FakePickerChrome } from "../fakes/picker-chrome-fake";

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

function createTestRuns(repoRoot: string): {
  runs: RunsBrowser;
  chrome: FakePickerChrome;
} {
  const chrome = fakePickerChrome();
  const deps: RunsBrowserDeps = {
    repoRoot,
    getContentWidth: () => 80,
    chrome,
    launchWorkbenchRoute: () => undefined,
  };
  return { runs: createRunsBrowser(deps), chrome };
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
    const { runs, chrome } = createTestRuns(root);
    expect(chrome.listHeight).toBe(99);
    await runs.enter();
    expect(chrome.listHeight).toBe(RUNS_LIST_VIEWPORT);
    const keepIdx = runsSelectedIndex(
      chrome.options().map((o) => (o.value as { run: RunListItem }).run),
      keep,
    );
    chrome.setSelectedIndex(keepIdx);
    runs.onSelectionChanged();
    await runs.refresh();
    expect(chrome.options().length).toBe(8);
    const idx = runsSelectedIndex(
      chrome.options().map((o) => (o.value as { run: RunListItem }).run),
      keep,
    );
    expect(chrome.selectedIndex()).toBe(idx);
    expect((chrome.options()[idx]!.value as { run: RunListItem }).run.id).toBe(keep);
  });

  test("overlapping detail opens keep the latest status content", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-pick-gen-"));
    dirs.push(root);
    const first = new RunHistorySession();
    await first.claim({
      workflow: "one",
      source: "repo",
      checkout_root: root,
      started_at: "2026-01-01T00:00:00.000Z",
    });
    await first.finalize("succeeded");
    const firstId = first.id!;
    first.dispose();
    const second = new RunHistorySession();
    await second.claim({
      workflow: "two",
      source: "repo",
      checkout_root: root,
      started_at: "2026-01-01T00:00:01.000Z",
    });
    await second.finalize("succeeded");
    const secondId = second.id!;
    second.dispose();
    const { runs, chrome } = createTestRuns(root);
    const older = runs.openDetail(firstId);
    await runs.openDetail(secondId);
    await older;
    expect(chrome.lastStatus()).toContain("two");
    expect(chrome.lastStatus()).not.toContain("one");
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

  test("escape while a run is in flight dismisses with zero", () => {
    expect(pickerEscapeExitCode("run", true)).toBe(0);
    expect(pickerEscapeExitCode("run", false)).toBe(1);
    expect(pickerEscapeExitCode("list", false)).toBe(0);
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
    await first.claim({
      workflow: "one",
      source: "repo",
      checkout_root: root,
      started_at: "2026-01-01T00:00:00.000Z",
    });
    await first.finalize("succeeded");
    const keep = first.id!;
    first.dispose();
    const second = new RunHistorySession();
    await second.claim({
      workflow: "two",
      source: "repo",
      checkout_root: root,
      started_at: "2026-01-01T00:00:01.000Z",
    });
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
    const { detail } = await runDetail("not-a-uuid");
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
    const { runs, chrome } = createTestRuns(root);
    await runs.enter();
    await runs.openDetail(keep);
    expect(runs.isDetail()).toBe(true);
    await runs.enter();
    expect(runs.isActive()).toBe(true);
    expect(runs.isDetail()).toBe(false);
    const idx = chrome.selectedIndex();
    expect((chrome.options()[idx]!.value as { run: RunListItem }).run.id).toBe(keep);
  });

  test("detail poll targets only running and stale statuses", () => {
    expect(isDetailPollableStatus("running")).toBe(true);
    expect(isDetailPollableStatus("stale")).toBe(true);
    expect(isDetailPollableStatus("succeeded")).toBe(false);
    expect(isDetailPollableStatus("failed")).toBe(false);
    expect(isDetailPollableStatus("interrupted")).toBe(false);
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
    expect(narrow).toBe("INTERRUPTED · . · 1s");
    expect(narrow.length).toBeLessThanOrEqual(20);
  });
});
