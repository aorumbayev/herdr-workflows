import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRepoRoot } from "../../src/history";
import {
  acquireEndpointLockSync,
  openWorkbench,
  endpointLockPath,
  endpointRecordPath,
  probeEndpoint,
  readEndpointRecord,
  releaseEndpointLockSync,
  writeEndpointRecord,
} from "../../src/web/endpoint";
import { appendRouteHash, parseWebRoute } from "../../src/web/endpoint";
import { startWebServer, type WebServer } from "../../src/web/server";

const dirs: string[] = [];
const servers: WebServer[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hwf-web-ep-"));
  dirs.push(dir);
  return dir;
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-web-repo-"));
  dirs.push(root);
  await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
  return canonicalRepoRoot(root);
}

describe("web route", () => {
  test("accepts edit, share, and import shapes", () => {
    expect(parseWebRoute("w=repo:deploy")).toEqual({
      kind: "w",
      scope: "repo",
      name: "deploy",
      hash: "w=repo:deploy",
    });
    expect(parseWebRoute("share=global:handoff")).toEqual({
      kind: "share",
      scope: "global",
      name: "handoff",
      hash: "share=global:handoff",
    });
    expect(parseWebRoute("import")).toEqual({ kind: "import", hash: "import" });
    expect(parseWebRoute("new")).toEqual({ kind: "new", hash: "new" });
    expect(parseWebRoute("run=550e8400-e29b-41d4-a716-446655440000")).toEqual({
      kind: "run",
      id: "550e8400-e29b-41d4-a716-446655440000",
      hash: "run=550e8400-e29b-41d4-a716-446655440000",
    });
  });

  test("rejects arbitrary URL text and invalid names", () => {
    expect(parseWebRoute("http://evil")).toBeUndefined();
    expect(parseWebRoute("w=repo:../x")).toBeUndefined();
    expect(parseWebRoute("w=other:name")).toBeUndefined();
    expect(parseWebRoute("share=")).toBeUndefined();
    expect(parseWebRoute("run=550e8400")).toBeUndefined();
  });

  test("appends hash only after the authenticated base URL", () => {
    const base = "http://127.0.0.1:7317/?token=abc";
    expect(appendRouteHash(base, parseWebRoute("import"))).toBe(`${base}#import`);
    expect(appendRouteHash(base, parseWebRoute("w=repo:x"))).toBe(`${base}#w=repo:x`);
    expect(appendRouteHash(base, undefined)).toBe(base);
  });
});

describe("endpoint lifecycle", () => {
  test("writes private endpoint records and probes authenticated state", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const server = await startWebServer({ repoRoot: root });
    servers.push(server);

    await writeEndpointRecord({ repoRoot: root, url: server.url }, stateDir);
    const path = endpointRecordPath(root, stateDir);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await probeEndpoint(server.url, root)).toBe(true);
    expect(await readEndpointRecord(root, stateDir)).toEqual({
      repoRoot: root,
      url: server.url,
    });
  });

  test("stale or mismatched records are not reused", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await writeEndpointRecord({ repoRoot: root, url: "http://127.0.0.1:1/?token=dead" }, stateDir);
    expect(await probeEndpoint("http://127.0.0.1:1/?token=dead", root)).toBe(false);

    let starts = 0;
    const first = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        start: async (opts) => {
          starts += 1;
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    stops.push(first.stop);
    expect(first.owned).toBe(true);
    expect(starts).toBe(1);
    expect(await readEndpointRecord(root, stateDir)).toEqual({
      repoRoot: root,
      url: first.url,
    });

    const other = await tempRepo();
    await writeEndpointRecord({ repoRoot: root, url: first.url }, stateDir);
    expect(await probeEndpoint(first.url, other)).toBe(false);
  });

  test("live matching endpoint is reused without starting another server", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    let starts = 0;
    const start = async (opts: { repoRoot: string; port?: number }) => {
      starts += 1;
      const s = await startWebServer(opts);
      servers.push(s);
      return s;
    };

    const owned = await openWorkbench({ repoRoot: root }, { stateDir, start });
    stops.push(owned.stop);
    expect(owned.owned).toBe(true);
    expect(starts).toBe(1);

    const reused = await openWorkbench({ repoRoot: root }, { stateDir, start });
    expect(reused.owned).toBe(false);
    expect(reused.url).toBe(owned.url);
    expect(starts).toBe(1);
  });

  // The invariant, tested at the point it matters: whatever a live workbench was built from, a
  // client running other code must not end up served by it.
  test("a live workbench built from other code is not adopted", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    let starts = 0;
    const start = async (opts: { repoRoot: string; port?: number }) => {
      starts += 1;
      const s = await startWebServer(opts);
      servers.push(s);
      return s;
    };

    const owned = await openWorkbench({ repoRoot: root, build: "ino:1:10" }, { stateDir, start });
    stops.push(owned.stop);
    expect(starts).toBe(1);

    const sameBuild = await openWorkbench(
      { repoRoot: root, build: "ino:1:10" },
      { stateDir, start },
    );
    expect(sameBuild.owned).toBe(false);
    expect(sameBuild.url).toBe(owned.url);
    expect(starts).toBe(1);

    const upgraded = await openWorkbench(
      { repoRoot: root, build: "ino:2:11" },
      { stateDir, start },
    );
    stops.push(upgraded.stop);
    expect(upgraded.owned).toBe(true);
    expect(upgraded.url).not.toBe(owned.url);
    expect(starts).toBe(2);
    expect((await readEndpointRecord(root, stateDir))?.build).toBe("ino:2:11");
  });

  test("a record predating build identity is not adopted by a build that has one", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    let starts = 0;
    const start = async (opts: { repoRoot: string; port?: number }) => {
      starts += 1;
      const s = await startWebServer(opts);
      servers.push(s);
      return s;
    };

    const legacy = await openWorkbench({ repoRoot: root }, { stateDir, start });
    stops.push(legacy.stop);
    expect((await readEndpointRecord(root, stateDir))?.build).toBeUndefined();

    const identified = await openWorkbench(
      { repoRoot: root, build: "ino:3:12" },
      { stateDir, start },
    );
    stops.push(identified.stop);
    expect(identified.owned).toBe(true);
    expect(starts).toBe(2);
  });

  test("an explicit port is honored instead of reusing an endpoint on another port", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const requested: number[] = [];
    const start = async (opts: { repoRoot: string; port?: number }) => {
      requested.push(opts.port ?? 0);
      const s = await startWebServer(opts);
      servers.push(s);
      return s;
    };

    const owned = await openWorkbench({ repoRoot: root }, { stateDir, start });
    stops.push(owned.stop);
    const ownedPort = Number(new URL(owned.url).port);

    const samePort = await openWorkbench({ repoRoot: root, port: ownedPort }, { stateDir, start });
    expect(samePort.owned).toBe(false);
    expect(samePort.url).toBe(owned.url);
    expect(requested).toEqual([0]);

    const probe = await startWebServer({ repoRoot: root });
    const freePort = Number(new URL(probe.url).port);
    probe.stop();

    const other = await openWorkbench({ repoRoot: root, port: freePort }, { stateDir, start });
    stops.push(other.stop);
    expect(other.owned).toBe(true);
    expect(Number(new URL(other.url).port)).toBe(freePort);
    expect(requested).toEqual([0, freePort]);
  });

  test("stop clears the owned endpoint record", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const owned = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        start: async (opts) => {
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    expect(await readEndpointRecord(root, stateDir)).toBeDefined();
    owned.stop();
    expect(await readEndpointRecord(root, stateDir)).toBeUndefined();
  });

  test("stop does not remove a newer owner's record after replacement", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const owned = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        start: async (opts) => {
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    const replacement = {
      repoRoot: root,
      url: "http://127.0.0.1:65530/?token=replacement-token",
    };
    await writeEndpointRecord(replacement, stateDir);
    owned.stop();
    expect(await readEndpointRecord(root, stateDir)).toEqual(replacement);
  });

  test("old-owner cleanup skips while successor holds the lock so successor record survives", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const owned = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        start: async (opts) => {
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    const gate = acquireEndpointLockSync(endpointLockPath(root, stateDir));
    expect(gate).toBeDefined();
    const successor = {
      repoRoot: root,
      url: "http://127.0.0.1:65528/?token=successor-under-lock",
    };
    await writeEndpointRecord(successor, stateDir);
    owned.stop();
    expect(await readEndpointRecord(root, stateDir)).toEqual(successor);
    releaseEndpointLockSync(gate!);
  });

  test("optimistic live check does not delete a record published during a failed probe", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    const live = await startWebServer({ repoRoot: root });
    servers.push(live);
    await writeEndpointRecord({ repoRoot: root, url: "http://127.0.0.1:1/?token=dead" }, stateDir);

    const result = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.includes("127.0.0.1:1")) {
            await writeEndpointRecord({ repoRoot: root, url: live.url }, stateDir);
            return new Response("", { status: 403 });
          }
          return fetch(input, init);
        }) as typeof fetch,
        start: async () => {
          throw new Error("should reuse the live record published during probe");
        },
      },
    );
    expect(result.owned).toBe(false);
    expect(result.url).toBe(live.url);
    expect(await readEndpointRecord(root, stateDir)).toEqual({
      repoRoot: root,
      url: live.url,
    });
  });

  test("two stale reclaimers: only one critical-section owner", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const base = endpointLockPath(root, stateDir);
    const stale = acquireEndpointLockSync(base);
    expect(stale).toBeDefined();
    const past = new Date(Date.now() - 60_000);
    await utimes(`${base}.${stale!.token}`, past, past);

    const endpointSrc = join(import.meta.dir, "..", "..", "src", "web", "endpoint.ts");
    const runReclaimer = async (): Promise<string> => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { acquireEndpointLockSync, releaseEndpointLockSync } from ${JSON.stringify(endpointSrc)};
            const hold = acquireEndpointLockSync(${JSON.stringify(base)}, Date.now, 10_000);
            if (!hold) {
              process.stdout.write("NONE");
              process.exit(0);
            }
            process.stdout.write("HOLD:" + hold.token);
            await Bun.sleep(150);
            releaseEndpointLockSync(hold);
          `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      return stdout;
    };

    const [a, b] = await Promise.all([runReclaimer(), runReclaimer()]);
    const holds = [a, b].filter((line) => line.startsWith("HOLD:"));
    expect(holds).toHaveLength(1);
    expect([a, b].filter((line) => line === "NONE")).toHaveLength(1);
  });

  test("stale reclaim loser cannot delete a successor claim after beforeSteal", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const base = endpointLockPath(root, stateDir);
    const stale = acquireEndpointLockSync(base);
    expect(stale).toBeDefined();
    const past = new Date(Date.now() - 60_000);
    await utimes(`${base}.${stale!.token}`, past, past);

    const endpointSrc = join(import.meta.dir, "..", "..", "src", "web", "endpoint.ts");
    const gateDir = await mkdtemp(join(tmpdir(), "hwf-reclaim-gate-"));
    dirs.push(gateDir);
    const ready = join(gateDir, "ready");
    const go = join(gateDir, "go");

    const blocked = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import { existsSync, writeFileSync } from "node:fs";
          import { acquireEndpointLockSync, releaseEndpointLockSync } from ${JSON.stringify(endpointSrc)};
          const hold = acquireEndpointLockSync(${JSON.stringify(base)}, Date.now, 10_000, {
            beforeSteal: () => {
              writeFileSync(${JSON.stringify(ready)}, "1");
              while (!existsSync(${JSON.stringify(go)})) {}
            },
          });
          process.stdout.write(hold ? "HOLD:" + hold.token : "NONE");
          if (hold) releaseEndpointLockSync(hold);
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(ready)).toBe(true);

    const winner = acquireEndpointLockSync(base, Date.now, 10_000);
    expect(winner).toBeDefined();
    expect(readFileSync(base, "utf8")).toBe(winner!.token);

    await writeFile(go, "1");
    const [blockedOut, blockedErr, blockedCode] = await Promise.all([
      new Response(blocked.stdout).text(),
      new Response(blocked.stderr).text(),
      blocked.exited,
    ]);
    expect(blockedCode).toBe(0);
    expect(blockedErr).toBe("");
    expect(blockedOut).toBe("NONE");
    expect(readFileSync(base, "utf8")).toBe(winner!.token);
    expect(existsSync(`${base}.${winner!.token}`)).toBe(true);
    releaseEndpointLockSync(winner!);
  });

  test("old-owner lock release does not delete a successor lock", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const base = endpointLockPath(root, stateDir);

    const oldHold = acquireEndpointLockSync(base);
    expect(oldHold).toBeDefined();
    const past = new Date(Date.now() - 60_000);
    await utimes(`${base}.${oldHold!.token}`, past, past);

    const successor = acquireEndpointLockSync(base, Date.now, 10_000);
    expect(successor).toBeDefined();
    expect(successor!.token).not.toBe(oldHold!.token);

    releaseEndpointLockSync(oldHold!);

    expect(readFileSync(base, "utf8")).toBe(successor!.token);
    expect(existsSync(`${base}.${successor!.token}`)).toBe(true);
    releaseEndpointLockSync(successor!);
  });

  test("publication failure stops the started server", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    let stopped = false;
    await expect(
      openWorkbench(
        { repoRoot: root },
        {
          stateDir,
          start: async () => ({
            url: "http://127.0.0.1:65529/?token=orphan",
            token: "orphan",
            stop: () => {
              stopped = true;
            },
          }),
          writeRecord: async () => {
            throw new Error("disk full");
          },
        },
      ),
    ).rejects.toThrow("disk full");
    expect(stopped).toBe(true);
    expect(await readEndpointRecord(root, stateDir)).toBeUndefined();
  });

  test("concurrent ensure starts only one server", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    let starts = 0;
    const start = async (opts: { repoRoot: string; port?: number }) => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 30));
      const s = await startWebServer(opts);
      servers.push(s);
      return s;
    };

    const [one, two] = await Promise.all([
      openWorkbench({ repoRoot: root }, { stateDir, start }),
      openWorkbench({ repoRoot: root }, { stateDir, start }),
    ]);
    stops.push(one.stop, two.stop);
    expect(starts).toBe(1);
    expect(new Set([one.url, two.url]).size).toBe(1);
    expect([one.owned, two.owned].filter(Boolean)).toHaveLength(1);
  });

  test("stale lock is reclaimed so later launch can proceed", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const base = endpointLockPath(root, stateDir);
    const stale = acquireEndpointLockSync(base);
    expect(stale).toBeDefined();
    const past = new Date(Date.now() - 60_000);
    await utimes(`${base}.${stale!.token}`, past, past);

    const owned = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        staleLockMs: 10_000,
        start: async (opts) => {
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    stops.push(owned.stop);
    expect(owned.owned).toBe(true);
    expect(await readEndpointRecord(root, stateDir)).toEqual({
      repoRoot: root,
      url: owned.url,
    });
  });

  test("legacy directory lock is reclaimed when stale", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const lock = endpointLockPath(root, stateDir);
    await mkdir(lock);
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);

    const owned = await openWorkbench(
      { repoRoot: root },
      {
        stateDir,
        staleLockMs: 10_000,
        start: async (opts) => {
          const s = await startWebServer(opts);
          servers.push(s);
          return s;
        },
      },
    );
    stops.push(owned.stop);
    expect(owned.owned).toBe(true);
  });

  test("fresh lock is not reclaimed before it ages out", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true, mode: 0o700 });
    const hold = acquireEndpointLockSync(endpointLockPath(root, stateDir));
    expect(hold).toBeDefined();

    await expect(
      openWorkbench(
        { repoRoot: root },
        {
          stateDir,
          lockAttempts: 3,
          lockWaitMs: 5,
          staleLockMs: 60_000,
          sleep: async () => undefined,
          start: async () => {
            throw new Error("should not start while fresh lock is held");
          },
        },
      ),
    ).rejects.toThrow("timed out waiting for repository workbench endpoint");
    releaseEndpointLockSync(hold!);
  });

  test("malformed record files are ignored", async () => {
    const stateDir = await tempState();
    const root = await tempRepo();
    await mkdir(join(stateDir, "web-endpoints"), { recursive: true });
    await writeFile(endpointRecordPath(root, stateDir), "{not-json", "utf8");
    expect(await readEndpointRecord(root, stateDir)).toBeUndefined();
  });
});
