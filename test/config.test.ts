import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillAgentArgv, globalConfigPath, loadConfig, repoConfigPath } from "../src/config";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  delete process.env.HOME;
});

async function withHome(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-repo-"));
  dirs.push(home, root);
  process.env.HOME = home;
  return { home, root };
}

describe("agents config", () => {
  test("repo overrides global agent", async () => {
    const { home, root } = await withHome();
    await mkdir(join(home, ".hwf"), { recursive: true });
    await mkdir(join(root, ".hwf"), { recursive: true });
    await writeFile(
      join(home, ".hwf", "config.yaml"),
      `agents:\n  claude: ["claude", "{prompt}"]\n`,
    );
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `agents:\n  claude: ["claude", "--print", "{prompt}"]\n`,
    );
    expect(globalConfigPath()).toBe(join(home, ".hwf", "config.yaml"));
    expect(repoConfigPath(root)).toBe(join(root, ".hwf", "config.yaml"));
    const cfg = await loadConfig(root);
    expect(cfg.agents.claude).toEqual(["claude", "--print", "{prompt}"]);
  });

  test("unknown key rejected", async () => {
    const { root } = await withHome();
    await mkdir(join(root, ".hwf"), { recursive: true });
    await writeFile(join(root, ".hwf", "config.yaml"), `agents: {}\nretries: 1\n`);
    await expect(loadConfig(root)).rejects.toThrow(/retries/);
  });

  test("missing prompt slot rejected", async () => {
    const { root } = await withHome();
    await mkdir(join(root, ".hwf"), { recursive: true });
    await writeFile(join(root, ".hwf", "config.yaml"), `agents:\n  claude: ["claude"]\n`);
    await expect(loadConfig(root)).rejects.toThrow(/prompt/);
  });

  test("sessions parses; repo overrides global per name", async () => {
    const { home, root } = await withHome();
    await mkdir(join(home, ".hwf"), { recursive: true });
    await mkdir(join(root, ".hwf"), { recursive: true });
    await writeFile(
      join(home, ".hwf", "config.yaml"),
      `agents: {}\nsessions:\n  codex: ["echo", "global"]\n  claude: ["echo", "g-claude"]\n`,
    );
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `agents: {}\nsessions:\n  codex: ["echo", "repo"]\n`,
    );
    const cfg = await loadConfig(root);
    expect(cfg.sessions.codex).toEqual(["echo", "repo"]);
    expect(cfg.sessions.claude).toEqual(["echo", "g-claude"]);
  });

  test("fillAgentArgv replaces prompt as one element", () => {
    expect(fillAgentArgv(["claude", "{prompt}"], "line1\nline2")).toEqual([
      "claude",
      "line1\nline2",
    ]);
  });
});
