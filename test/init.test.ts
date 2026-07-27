import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { detectAgents, formatAgentsYaml, runInit } from "../src/init";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("herdr-workflows init", () => {
  test("fresh init writes agents config", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const detected = await detectAgents();
    const result = await runInit(root, { home });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("agents:");
    const cfg = await loadConfig(root);
    for (const name of Object.keys(detected)) {
      expect(cfg.agents[name]).toEqual(detected[name]);
    }
  });

  test("existing config preserved without confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf"), { recursive: true });
    const path = join(root, ".hwf", "config.yaml");
    await writeFile(path, `agents:\n  claude: ["claude", "{prompt}"]\n`);
    const result = await runInit(root);
    expect(result.kind).toBe("exists");
    expect(await readFile(path, "utf8")).toContain("claude");
  });

  test("formatAgentsYaml emits prompt slots", () => {
    expect(formatAgentsYaml({ claude: ["claude", "{prompt}"] })).toContain('"{prompt}"');
  });

  test("force init preserves sessions in config", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    await mkdir(join(root, ".hwf"), { recursive: true });
    const path = join(root, ".hwf", "config.yaml");
    await writeFile(
      path,
      `agents:\n  claude: ["claude", "{prompt}"]\nsessions:\n  claude: ["claude", "-p", "--output-format", "json", "-"]\n`,
    );
    const result = await runInit(root, { force: true, home });
    expect(result.kind).toBe("overwritten");
    const text = await readFile(path, "utf8");
    expect(text).toContain("sessions:");
    expect(text).toContain("claude:");
    const cfg = await loadConfig(root);
    expect(cfg.sessions.claude).toEqual(["claude", "-p", "--output-format", "json", "-"]);
  });

  test("init seeds no workflows — examples are imported instead", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    await runInit(root, { home });
    expect(await readdir(join(root, ".hwf", "workflows"))).toEqual([]);
    expect(await readdir(join(home, ".hwf", "workflows"))).toEqual([]);
  });
});
