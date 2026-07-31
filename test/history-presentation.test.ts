import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebServer } from "../src/web/server";

const dirs: string[] = [];
const servers: WebServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function servedPage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-runs-pres-"));
  dirs.push(root);
  const s = await startWebServer({ repoRoot: root });
  servers.push(s);
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  return await res.text();
}

const PURE_START = "/* ---------- runs inspector pure state ---------- */";
const PURE_END = "/* ---------- end runs inspector pure state ---------- */";

type RunsPure = {
  runRowFocusId: (id: string) => string;
  runsBackFocusId: () => string;
  parseRunHash: (hash: string) => { kind: string; id?: string; complete?: boolean };
  seedSelectedStatus: (id: string | null, status: string | null) => void;
  observeRunStatus: (id: string, status: string) => string | null;
  resolveFocusAfterPaint: (saved: string | null, selectedId: string | null) => string | null;
  beginRunRouteLoad: () => number;
  invalidateRunRoute: () => number;
  exitRouteView: (view: { kind: string } | null) => null;
  shouldApplyRouteLoad: (routeGen: number, active?: number) => boolean;
  adoptRunsSelection: (
    runs: { id: string; status: string }[],
    selectedId: string | null,
    forceList: boolean,
    hasRouteView: boolean,
  ) => string | null;
  getSelected: () => { id: string | null; status: string | null };
  getRouteGen: () => number;
};

/** Execute the served page's runs pure-state block — production wiring, not a test oracle. */
function runsPure(page: string): RunsPure {
  const start = page.indexOf(PURE_START);
  const end = page.indexOf(PURE_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = page.slice(start, end);
  return new Function(`
    let runsRouteGen = 0;
    let runsSelectedStatusId = null;
    let runsSelectedStatus = null;
    ${block}
    return {
      runRowFocusId,
      runsBackFocusId,
      parseRunHash,
      seedSelectedStatus,
      observeRunStatus,
      resolveFocusAfterPaint,
      beginRunRouteLoad,
      invalidateRunRoute,
      exitRouteView,
      shouldApplyRouteLoad,
      adoptRunsSelection,
      getSelected: () => ({ id: runsSelectedStatusId, status: runsSelectedStatus }),
      getRouteGen: () => runsRouteGen,
    };
  `)() as RunsPure;
}

describe("runs workbench presentation", () => {
  test("served page wires route exit, auto-select announce, and back focus", async () => {
    const page = await servedPage();
    expect(page).toContain("beginRunRouteLoad");
    expect(page).toContain("exitRouteView");
    expect(page).toContain("adoptRunsSelection");
    expect(page).toContain("observeRunStatus");
    expect(page).toContain("runsBackFocusId");
    expect(page).not.toContain("legacyDetailFromRow");
    expect(page).not.toContain('kind: "legacy"');
    expect(page).not.toContain("detail unavailable for legacy history");
    expect(page).toMatch(/back\.id\s*=\s*runsBackFocusId\s*\(\s*\)/);
    expect(page).toMatch(
      /\.tab[\s\S]*?onclick\s*=\s*\(\)\s*=>\s*\{[\s\S]*?routeView\s*=\s*exitRouteView\s*\(\s*routeView\s*\)/,
    );

    const api = runsPure(page);
    const id = "550e8400-e29b-41d4-a716-446655440000";

    const routeGen = api.beginRunRouteLoad();
    expect(api.shouldApplyRouteLoad(routeGen)).toBe(true);
    expect(api.exitRouteView({ kind: "run" })).toBeNull();
    expect(api.shouldApplyRouteLoad(routeGen)).toBe(false);
    expect(api.getRouteGen()).toBeGreaterThan(routeGen);
    const after = api.getRouteGen();
    api.exitRouteView({ kind: "share" });
    expect(api.getRouteGen()).toBe(after);

    const runs = [{ id, status: "running" }];
    const selected = api.adoptRunsSelection(runs, null, false, false);
    expect(selected).toBe(id);
    expect(api.getSelected()).toEqual({ id, status: "running" });
    expect(api.observeRunStatus(id, "running")).toBeNull();
    expect(api.observeRunStatus(id, "succeeded")).toBe("running");

    const backId = api.runsBackFocusId();
    expect(backId).toBe("runs-back");
    expect(api.resolveFocusAfterPaint(backId, id)).toBe(backId);
    expect(api.resolveFocusAfterPaint(null, id)).toBe(api.runRowFocusId(id));
  });
});
