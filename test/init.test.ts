import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { detectAgents, formatAgentsYaml, runInit, seedWorkflows } from "../src/init";
import { loadWorkflow } from "../src/workflows";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("herdr-workflows init", () => {
  test("fresh init writes agents config", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    dirs.push(root);
    const detected = await detectAgents();
    const result = await runInit(root);
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

  test("seeded workflows pass the workflow loader and never overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    dirs.push(root);
    const dir = join(root, ".hwf", "workflows");
    await mkdir(dir, { recursive: true });
    const written = await seedWorkflows(dir, "claude");
    expect(written.sort()).toEqual(["handoff", "review"]);
    for (const name of written) {
      const workflow = await loadWorkflow(name, root, ["claude"]);
      expect(workflow.steps.length).toBeGreaterThan(0);
    }
    await writeFile(join(dir, "handoff.yaml"), "steps:\n  - shell: edited\n");
    const again = await seedWorkflows(dir, "claude");
    expect(again).toEqual([]);
    expect(await readFile(join(dir, "handoff.yaml"), "utf8")).toContain("edited");
  });
});
