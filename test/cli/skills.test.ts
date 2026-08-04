import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const home = await mkdtemp(join(tmpdir(), "hwf-skills-home-"));
  const state = await mkdtemp(join(tmpdir(), "hwf-skills-state-"));
  const plugin = await mkdtemp(join(tmpdir(), "hwf-skills-plugin-"));
  try {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      HERDR_PLUGIN_CONFIG_DIR: plugin,
      HERDR_PLUGIN_STATE_DIR: state,
    };
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_PLUGIN_CONTEXT_JSON;
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "..", "src", "cli.ts"), ...args],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true }),
      rm(plugin, { recursive: true, force: true }),
    ]);
  }
}

describe("hwf skills", () => {
  test("list prints every bundled skill with its frontmatter description", async () => {
    const { stdout, stderr, code } = await runCli(["skills", "list"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^herdr-workflow-create — \S/);
    expect(lines[1]).toMatch(/^herdr-workflow-upgrade — \S/);
  });

  test("show prints SKILL.md and reference files with path headers", async () => {
    const { stdout, code } = await runCli(["skills", "show", "herdr-workflow-create"]);
    expect(code).toBe(0);
    expect(stdout).toContain("==> skills/herdr-workflow-create/SKILL.md <==");
    expect(stdout).toContain("==> skills/herdr-workflow-create/reference/herdr-api.md <==");
    expect(stdout).toContain("==> skills/herdr-workflow-create/reference/recipes.md <==");
    expect(stdout).toContain("==> skills/herdr-workflow-create/reference/syntax.md <==");
    expect(stdout).toContain("==> skills/herdr-workflow-create/scripts/validate.sh <==");
    expect(stdout).toContain("name: herdr-workflow-create");
    expect(stdout).not.toContain("herdr-workflow-upgrade/SKILL.md");
  });

  test("show prints the upgrade skill with its breakage reference", async () => {
    const { stdout, code } = await runCli(["skills", "show", "herdr-workflow-upgrade"]);
    expect(code).toBe(0);
    expect(stdout).toContain("==> skills/herdr-workflow-upgrade/SKILL.md <==");
    expect(stdout).toContain("==> skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md <==");
    expect(stdout).toContain("name: herdr-workflow-upgrade");
  });

  test("show fails on an unknown skill and names the available ones", async () => {
    const { stdout, stderr, code } = await runCli(["skills", "show", "nope"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown skill 'nope'");
    expect(stderr).toContain("herdr-workflow-create");
    expect(stderr).toContain("herdr-workflow-upgrade");
  });
});
