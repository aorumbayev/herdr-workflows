import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runInit } from "../src/init";

const dirs: string[] = [];
const prevPluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevPluginDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevPluginDir;
});

async function withPluginEnv(): Promise<{ root: string; plugin: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
  const plugin = await mkdtemp(join(tmpdir(), "herdr-workflows-plugin-"));
  dirs.push(root, plugin);
  process.env.HERDR_PLUGIN_CONFIG_DIR = plugin;
  return { root, plugin };
}

describe("herdr-workflows init", () => {
  test("fresh init writes profiles config and gitignores local", async () => {
    const { root } = await withPluginEnv();
    const result = await runInit(root);
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("profiles:");
    expect(text).not.toContain("agents:");
    expect(text).not.toContain("{prompt}");
    const ignore = await readFile(join(root, ".hwf", ".gitignore"), "utf8");
    expect(ignore).toContain("config.local.yaml");
    const cfg = await loadConfig(root);
    for (const name of result.profiles) {
      expect(cfg.profiles[name]).toEqual({ kind: name });
    }
    if (result.profiles.length > 0) {
      expect(cfg.default_profile).toBe(result.profiles.sort()[0]);
    }
  });

  test("existing config preserved without confirmation", async () => {
    const { root } = await withPluginEnv();
    await mkdir(join(root, ".hwf"), { recursive: true });
    const path = join(root, ".hwf", "config.yaml");
    await writeFile(path, `profiles:\n  claude:\n    kind: claude\n`);
    const result = await runInit(root);
    expect(result.kind).toBe("exists");
    expect(await readFile(path, "utf8")).toContain("claude");
  });

  test("force init preserves transcripts in config", async () => {
    const { root } = await withPluginEnv();
    await mkdir(join(root, ".hwf"), { recursive: true });
    const path = join(root, ".hwf", "config.yaml");
    await writeFile(
      path,
      `profiles:\n  claude:\n    kind: claude\ntranscripts:\n  claude:\n    command: ["claude", "-p"]\n`,
    );
    const result = await runInit(root, { force: true });
    expect(result.kind).toBe("overwritten");
    const text = await readFile(path, "utf8");
    expect(text).toContain("transcripts:");
    expect(text).toContain("claude:");
    const cfg = await loadConfig(root);
    expect(cfg.transcripts.claude?.command).toEqual(["claude", "-p"]);
  });

  test("init seeds no workflows — examples are imported instead", async () => {
    const { root } = await withPluginEnv();
    await runInit(root);
    expect(await readdir(join(root, ".hwf", "workflows"))).toEqual([]);
  });

  test("init does not write ~/.hwf/config.yaml", async () => {
    const { root } = await withPluginEnv();
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await runInit(root);
      expect(await Bun.file(join(home, ".hwf", "config.yaml")).exists()).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("init --global writes plugin config dir, not repo .hwf", async () => {
    const { root, plugin } = await withPluginEnv();
    const result = await runInit(root, { global: true });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    expect(result.path).toBe(join(plugin, "config.yaml"));
    expect(await Bun.file(result.path).exists()).toBe(true);
    expect(await Bun.file(join(root, ".hwf", "config.yaml")).exists()).toBe(false);
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("profiles:");
    for (const name of result.profiles) {
      expect(text).toContain(`${name}:`);
    }
  });

  test("init --global preserves existing without confirmation", async () => {
    const { root, plugin } = await withPluginEnv();
    const path = join(plugin, "config.yaml");
    await writeFile(path, `profiles:\n  claude:\n    kind: claude\n`);
    const result = await runInit(root, { global: true });
    expect(result.kind).toBe("exists");
    expect(await readFile(path, "utf8")).toContain("claude");
  });
});
