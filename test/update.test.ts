import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  fetchLatestPublishedRelease,
  leavePluginRoot,
  parsePluginListSource,
  parseReleaseTag,
  ReleaseCheckError,
  runUpdate,
} from "../src/update";
import { PRODUCT_VERSION } from "../src/version";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const NEWER = "0.999.0";

async function writeFakeHerdr(pluginListJson: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hwf-update-herdr-"));
  dirs.push(dir);
  const bin = join(dir, "fake-herdr");
  const script = `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  printf '%s\\n' ${JSON.stringify(pluginListJson)}
  exit 0
fi
exit 1
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return bin;
}

function githubListJson(): string {
  return JSON.stringify({
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
  });
}

function localListJson(): string {
  return JSON.stringify({
    id: "cli:plugin",
    result: {
      type: "plugin_list",
      plugins: [{ plugin_id: "herdr-workflows", source: { kind: "local" } }],
    },
  });
}

function emptyListJson(): string {
  return JSON.stringify({
    id: "cli:plugin",
    result: { type: "plugin_list", plugins: [] },
  });
}

async function captureRunUpdate(
  deps: Parameters<typeof runUpdate>[0],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; exitCode?: number; error?: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let exitCode: number | undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  }) as typeof process.exit;
  const beforeCwd = process.cwd();
  try {
    await runUpdate(deps);
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("exit:")) {
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
    }
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode, error };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(beforeCwd);
  }
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
    const result = await captureRunUpdate({
      fetchLatest: async () => ({ tag: `v${PRODUCT_VERSION}`, version: PRODUCT_VERSION }),
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(`already up to date (${PRODUCT_VERSION})`);
  });

  test("refuses linked development checkouts", async () => {
    const herdr = await writeFakeHerdr(localListJson());
    const result = await captureRunUpdate(
      { fetchLatest: async () => ({ tag: `v${NEWER}`, version: NEWER }) },
      { HERDR_BIN_PATH: herdr },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/bun run install:dev/);
  });

  test("explains unregistered binaries", async () => {
    const herdr = await writeFakeHerdr(emptyListJson());
    const result = await captureRunUpdate(
      { fetchLatest: async () => ({ tag: `v${NEWER}`, version: NEWER }) },
      { HERDR_BIN_PATH: herdr },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/herdr plugin install aorumbayev\/herdr-workflows/);
  });

  test("leaves plugin root and forwards install failure", async () => {
    const herdr = await writeFakeHerdr(githubListJson());
    const pluginRoot = await mkdtemp(join(tmpdir(), "hwf-managed-plugin-"));
    dirs.push(pluginRoot);
    const installs: Array<{ args: string[]; cwd: string }> = [];
    const result = await captureRunUpdate(
      {
        fetchLatest: async () => ({ tag: `v${NEWER}`, version: NEWER }),
        runInstall: async (args, cwd) => {
          installs.push({ args, cwd });
          return 7;
        },
      },
      { HERDR_BIN_PATH: herdr, HERDR_PLUGIN_ROOT: pluginRoot },
    );
    expect(result.exitCode).toBe(7);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.args).toEqual(["plugin", "install", "aorumbayev/herdr-workflows", "--yes"]);
    expect(installs[0]!.cwd).not.toBe(pluginRoot);
    expect(result.stdout).toContain(`updating ${PRODUCT_VERSION} → ${NEWER}`);
    expect(result.stderr).toContain("exit 7");
  });

  test("successful managed install", async () => {
    const herdr = await writeFakeHerdr(githubListJson());
    const pluginRoot = await mkdtemp(join(tmpdir(), "hwf-managed-plugin-"));
    dirs.push(pluginRoot);
    const result = await captureRunUpdate(
      {
        fetchLatest: async () => ({ tag: `v${NEWER}`, version: NEWER }),
        runInstall: async () => 0,
      },
      { HERDR_BIN_PATH: herdr, HERDR_PLUGIN_ROOT: pluginRoot },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(`updated to ${NEWER}`);
  });

  test("parsePluginListSource distinguishes github, local, and missing", () => {
    expect(parsePluginListSource(githubListJson())).toEqual({
      kind: "github",
      owner: "aorumbayev",
      repo: "herdr-workflows",
    });
    expect(parsePluginListSource(localListJson())).toEqual({ kind: "local" });
    expect(parsePluginListSource(emptyListJson())).toEqual({ kind: "unregistered" });
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
