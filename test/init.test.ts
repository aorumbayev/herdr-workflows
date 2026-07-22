import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  detectAgents,
  formatAgentsYaml,
  parsePlaybookSeedScope,
  PLAYBOOK_SEED_WORKFLOWS,
  REPO_SEED_WORKFLOWS,
  runInit,
  seedWorkflows,
} from "../src/init";
import { loadWorkflow } from "../src/workflows";

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
    const result = await runInit(root, { home, playbookScope: "skip" });
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

  test("parsePlaybookSeedScope accepts aliases", () => {
    expect(parsePlaybookSeedScope("G")).toBe("global");
    expect(parsePlaybookSeedScope("repo")).toBe("repo");
    expect(parsePlaybookSeedScope("none")).toBe("skip");
    expect(parsePlaybookSeedScope("nope")).toBeUndefined();
  });

  test("playbook seeds handoff+worktree; review is repo-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const repoDir = join(root, ".hwf", "workflows");
    const globalDir = join(home, ".hwf", "workflows");
    await mkdir(repoDir, { recursive: true });

    expect(await seedWorkflows(repoDir, "claude", REPO_SEED_WORKFLOWS)).toEqual(["review"]);
    expect((await seedWorkflows(globalDir, "claude", PLAYBOOK_SEED_WORKFLOWS)).sort()).toEqual([
      "handoff",
      "worktree",
    ]);

    const handoff = await readFile(join(globalDir, "handoff.yaml"), "utf8");
    expect(handoff).toContain('agent: "{agent}"');
    expect(handoff).toContain('stdin: "{session}"');
    expect(handoff).toContain("close_source: true");

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const workflow = await loadWorkflow("handoff", root, ["claude"]);
      expect(workflow.needsSession).toBe(true);
      expect(workflow.needsInvokingAgent).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("runInit playbookScope=global seeds ~/.hwf handoff/worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const detected = await detectAgents();
    if (Object.keys(detected).length === 0) return;

    const result = await runInit(root, { home, playbookScope: "global" });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    expect(result.playbookScope).toBe("global");
    expect(result.workflows).toEqual(["review"]);
    expect(result.globalWorkflows.sort()).toEqual(["handoff", "worktree"]);
    expect(await Bun.file(join(home, ".hwf", "workflows", "handoff.yaml")).exists()).toBe(true);
    expect(await Bun.file(join(root, ".hwf", "workflows", "handoff.yaml")).exists()).toBe(false);
  });

  test("runInit playbookScope=repo seeds handoff/worktree into cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const detected = await detectAgents();
    if (Object.keys(detected).length === 0) return;

    const result = await runInit(root, { home, playbookScope: "repo" });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    expect(result.playbookScope).toBe("repo");
    expect(result.workflows.sort()).toEqual(["handoff", "review", "worktree"]);
    expect(result.globalWorkflows).toEqual([]);
    expect(await Bun.file(join(root, ".hwf", "workflows", "handoff.yaml")).exists()).toBe(true);
    expect(await Bun.file(join(home, ".hwf", "workflows", "handoff.yaml")).exists()).toBe(false);
  });

  test("runInit playbookScope=skip leaves handoff/worktree unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const detected = await detectAgents();
    if (Object.keys(detected).length === 0) return;

    const result = await runInit(root, { home, playbookScope: "skip" });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    expect(result.playbookScope).toBe("skip");
    expect(result.workflows).toEqual(["review"]);
    expect(result.globalWorkflows).toEqual([]);
  });

  test("choosePlaybookScope callback is honored", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-init-"));
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(root, home);
    const detected = await detectAgents();
    if (Object.keys(detected).length === 0) return;

    const result = await runInit(root, {
      home,
      choosePlaybookScope: async () => "repo",
    });
    expect(result.kind).toBe("wrote");
    if (result.kind === "exists") throw new Error("unreachable");
    expect(result.playbookScope).toBe("repo");
    expect(result.workflows).toContain("handoff");
  });
});
