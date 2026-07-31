import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  compareSemver,
  fetchLatestPublishedRelease,
  parseReleaseTag,
  ReleaseCheckError,
} from "../src/update";
import { leavePluginRoot, parsePluginListSource, runUpdate } from "../src/update";

function fail(message: string): never {
  throw new Error(message);
}

describe("release-check", () => {
  test("parses strict v0.x.y tags and rejects others", () => {
    expect(parseReleaseTag("v0.2.3")).toEqual({ tag: "v0.2.3", version: "0.2.3" });
    expect(() => parseReleaseTag("0.2.3")).toThrow(ReleaseCheckError);
    expect(() => parseReleaseTag("v1.0.0")).toThrow(ReleaseCheckError);
    expect(() => parseReleaseTag("v0.2.3-beta")).toThrow(ReleaseCheckError);
  });

  test("compares 0.x.y versions", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("0.3.1", "0.2.9")).toBeGreaterThan(0);
  });

  test("fetchLatestPublishedRelease validates JSON and respects timeout", async () => {
    const ok = await fetchLatestPublishedRelease({
      fetchImpl: async () =>
        new Response(JSON.stringify({ tag_name: "v0.4.0", draft: false }), { status: 200 }),
    });
    expect(ok).toEqual({ tag: "v0.4.0", version: "0.4.0" });

    await expect(
      fetchLatestPublishedRelease({
        fetchImpl: async () => new Response("nope", { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);

    await expect(
      fetchLatestPublishedRelease({
        fetchImpl: async () =>
          new Response(JSON.stringify({ tag_name: "v0.4.0", draft: true }), { status: 200 }),
      }),
    ).rejects.toThrow(/draft/);

    await expect(
      fetchLatestPublishedRelease({
        timeoutMs: 20,
        fetchImpl: async (_url, init) => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 500);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
          return new Response("{}");
        },
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("update", () => {
  test("no-ops when current or newer", async () => {
    const lines: string[] = [];
    await runUpdate({
      embeddedVersion: "0.2.0",
      fetchLatest: async () => ({ tag: "v0.2.0", version: "0.2.0" }),
      write: (t) => lines.push(t),
      fail,
    });
    expect(lines.join("")).toContain("already up to date (0.2.0)");
  });

  test("refuses linked development checkouts", async () => {
    await expect(
      runUpdate({
        embeddedVersion: "0.1.0",
        fetchLatest: async () => ({ tag: "v0.2.0", version: "0.2.0" }),
        resolveSource: async () => ({ kind: "local" }),
        write: () => {},
        fail,
      }),
    ).rejects.toThrow(/bun run install:dev/);
  });

  test("explains unregistered binaries", async () => {
    await expect(
      runUpdate({
        embeddedVersion: "0.1.0",
        fetchLatest: async () => ({ tag: "v0.2.0", version: "0.2.0" }),
        resolveSource: async () => ({ kind: "unregistered" }),
        write: () => {},
        fail,
      }),
    ).rejects.toThrow(/herdr plugin install aorumbayev\/herdr-workflows/);
  });

  test("leaves plugin root and forwards install failure", async () => {
    const installs: Array<{ args: string[]; cwd: string }> = [];
    const lines: string[] = [];
    const errs: string[] = [];
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    try {
      await expect(
        runUpdate({
          embeddedVersion: "0.1.0",
          fetchLatest: async () => ({ tag: "v0.2.0", version: "0.2.0" }),
          resolveSource: async () => ({
            kind: "github",
            owner: "aorumbayev",
            repo: "herdr-workflows",
          }),
          leaveDir: () => "/tmp/outside",
          runInstall: async (args, cwd) => {
            installs.push({ args, cwd });
            return 7;
          },
          write: (t) => lines.push(t),
          writeErr: (t) => errs.push(t),
          fail,
          env: { HERDR_PLUGIN_ROOT: "/managed/plugin" },
        }),
      ).rejects.toThrow(/exit:7/);
    } finally {
      process.exit = originalExit;
    }
    expect(installs).toEqual([
      { args: ["plugin", "install", "aorumbayev/herdr-workflows", "--yes"], cwd: "/tmp/outside" },
    ]);
    expect(lines.join("")).toContain("updating 0.1.0 → 0.2.0");
    expect(errs.join("")).toContain("exit 7");
  });

  test("successful managed install", async () => {
    const lines: string[] = [];
    await runUpdate({
      embeddedVersion: "0.1.0",
      fetchLatest: async () => ({ tag: "v0.2.0", version: "0.2.0" }),
      resolveSource: async () => ({ kind: "github" }),
      leaveDir: () => "/tmp/outside",
      runInstall: async () => 0,
      write: (t) => lines.push(t),
      fail,
    });
    expect(lines.join("")).toContain("updated to 0.2.0");
  });

  test("parsePluginListSource distinguishes github, local, and missing", () => {
    expect(
      parsePluginListSource(
        JSON.stringify({
          id: "cli:plugin",
          result: {
            type: "plugin_list",
            plugins: [
              {
                plugin_id: "herdr-workflows",
                source: { kind: "github", owner: "aorumbayev", repo: "herdr-workflows" },
              },
            ],
          },
        }),
      ),
    ).toEqual({ kind: "github", owner: "aorumbayev", repo: "herdr-workflows" });
    expect(
      parsePluginListSource(
        JSON.stringify({
          id: "cli:plugin",
          result: {
            type: "plugin_list",
            plugins: [{ plugin_id: "herdr-workflows", source: { kind: "local" } }],
          },
        }),
      ),
    ).toEqual({ kind: "local" });
    expect(
      parsePluginListSource(
        JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins: [] } }),
      ),
    ).toEqual({ kind: "unregistered" });
    expect(
      parsePluginListSource(
        JSON.stringify({
          result: {
            type: "plugin_list",
            plugins: [{ plugin_id: "other", source: { kind: "github" } }],
          },
        }),
      ),
    ).toEqual({ kind: "unregistered" });
    expect(
      parsePluginListSource(JSON.stringify({ plugins: [{ plugin_id: "herdr-workflows" }] })),
    ).toEqual({
      kind: "unregistered",
    });
  });

  test("leavePluginRoot moves cwd outside the managed checkout", () => {
    const before = process.cwd();
    try {
      const outside = leavePluginRoot(before, {
        ...process.env,
        HOME: process.env.HOME || before,
      });
      expect(outside).not.toBe(before);
    } finally {
      process.chdir(before);
    }
  });

  test("update help is registered without loading the picker", async () => {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "update", "--help"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HERDR_BIN_PATH: "/does-not-exist/herdr",
        HERDR_SOCKET_PATH: "",
      },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Update to the latest published GitHub Release/);
  });
});
