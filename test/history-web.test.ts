import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginStateDir } from "../src/config";
import { allocateRunId, RunHistorySession } from "../src/history/store";
import { parseWebRoute, runWorkbenchRoute } from "../src/web/route";
import { startWebServer } from "../src/web/server";

const dirs: string[] = [];
let prevState: string | undefined;

beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "hwf-hist-web-"));
  dirs.push(state);
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-hist-web-repo-"));
  dirs.push(root);
  await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
  await writeFile(
    join(root, ".hwf", "workflows", "demo.yaml"),
    "version: v1alpha1\nsteps:\n  - run: [printf, hi]\n",
  );
  return root;
}

function apiBase(server: { url: string }): string {
  return new URL(server.url).origin;
}

describe("run history web API", () => {
  test("unauthorized access is forbidden", async () => {
    const root = await repo();
    const server = await startWebServer({ repoRoot: root });
    try {
      const res = await fetch(`${apiBase(server)}/api/runs`);
      expect(res.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("list and detail use no-store and exclude private output", async () => {
    const root = await repo();
    const session = new RunHistorySession();
    await session.claim({
      workflow: "demo",
      source: "repo",
      checkout_root: root,
    });
    await session.recordStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 1,
      action: "run",
      label: "boom",
      finished_at: new Date().toISOString(),
      outcome: "failed",
      failure: { action: "run", exit_code: 2 },
      explanation: "secret-stdout-body",
    });
    await session.finalize("failed");
    session.dispose();

    const server = await startWebServer({ repoRoot: root });
    try {
      const list = await fetch(`${apiBase(server)}/api/runs`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(list.headers.get("cache-control")).toBe("no-store");
      const listBody = (await list.json()) as {
        ok: boolean;
        runs: { id: string; failure?: { exit_code?: number } }[];
      };
      expect(listBody.ok).toBe(true);
      expect(JSON.stringify(listBody)).not.toContain("secret-stdout-body");
      expect(listBody.runs[0]?.failure?.exit_code).toBe(2);

      const detail = await fetch(`${apiBase(server)}/api/run?id=${listBody.runs[0]!.id}`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(detail.headers.get("cache-control")).toBe("no-store");
      const detailBody = (await detail.json()) as {
        ok: boolean;
        detail: { failure_explanation?: string; open_workflow?: { name: string } };
      };
      expect(detailBody.detail.failure_explanation).toBe("secret-stdout-body");
      expect(detailBody.detail.open_workflow?.name).toBe("demo");

      const page = await fetch(server.url);
      expect(page.headers.get("cache-control")).toBe("no-store");
    } finally {
      server.stop();
    }
  });

  test("malformed UUID and foreign deep links", async () => {
    const root = await repo();
    const foreign = await mkdtemp(join(tmpdir(), "hwf-foreign-"));
    dirs.push(foreign);
    const session = new RunHistorySession();
    await session.claim({
      workflow: "other",
      source: "global",
      checkout_root: foreign,
    });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();

    const server = await startWebServer({ repoRoot: root });
    try {
      const bad = await fetch(`${apiBase(server)}/api/run?id=550e8400`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(bad.status).toBe(400);
      const body = (await bad.json()) as { detail: { kind: string } };
      expect(body.detail.kind).toBe("invalid");

      const foreignDetail = await fetch(`${apiBase(server)}/api/run?id=${id}`, {
        headers: { "x-hwf-token": server.token },
      });
      const foreignBody = (await foreignDetail.json()) as {
        ok: boolean;
        detail: { checkout_root?: string; open_workflow?: unknown };
      };
      expect(foreignBody.ok).toBe(true);
      expect(foreignBody.detail.checkout_root).toBe(await realpath(foreign));
      expect(foreignBody.detail.open_workflow).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("unsafe storage returns unavailable", async () => {
    const root = await repo();
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
    await mkdir(state, { recursive: true });
    await chmod(state, 0o755);
    const server = await startWebServer({ repoRoot: root });
    try {
      const list = await fetch(`${apiBase(server)}/api/runs`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(list.status).toBe(503);
    } finally {
      server.stop();
    }
  });

  test("prior shared runs.jsonl does not appear in All", async () => {
    const root = await repo();
    const priorPath = join(pluginStateDir(), "runs.jsonl");
    const body = `${JSON.stringify({
      ts: "2020-01-01T00:00:00.000Z",
      run: "abcd1234",
      workflow: "old-log",
      ok: true,
    })}\n`;
    await writeFile(priorPath, body, { mode: 0o600 });
    const server = await startWebServer({ repoRoot: root });
    try {
      const base = apiBase(server);
      const all = await fetch(`${base}/api/runs?location=all`, {
        headers: { "x-hwf-token": server.token },
      });
      const allBody = (await all.json()) as { runs: { workflow: string }[] };
      expect(allBody.runs.every((r) => r.workflow !== "old-log")).toBe(true);
      expect(await Bun.file(priorPath).text()).toBe(body);
    } finally {
      server.stop();
    }
  });

  test("route parsing requires complete UUID", () => {
    const id = allocateRunId();
    const parsed = parseWebRoute(runWorkbenchRoute(id));
    expect(parsed).toEqual({
      kind: "run",
      id,
      hash: `run=${id}`,
    });
    expect(parseWebRoute("run=550e8400")).toBeUndefined();
    const upper = parseWebRoute(`run=${id.toUpperCase()}`);
    expect(upper?.kind === "run" ? upper.id : undefined).toBe(id);
  });

  test("deleted root remains inspectable without open action", async () => {
    const root = await repo();
    const gone = join(tmpdir(), `hwf-gone-${Date.now()}`);
    await mkdir(gone, { recursive: true });
    const canonicalGone = await realpath(gone);
    const session = new RunHistorySession();
    await session.claim({
      workflow: "demo",
      source: "repo",
      checkout_root: gone,
    });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();
    await rm(gone, { recursive: true, force: true });

    const server = await startWebServer({ repoRoot: root });
    try {
      const detail = await fetch(`${apiBase(server)}/api/run?id=${id}`, {
        headers: { "x-hwf-token": server.token },
      });
      const body = (await detail.json()) as {
        ok: boolean;
        detail: { checkout_root?: string; open_workflow?: unknown };
      };
      expect(body.ok).toBe(true);
      expect(body.detail.checkout_root).toBe(canonicalGone);
      expect(body.detail.open_workflow).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});
