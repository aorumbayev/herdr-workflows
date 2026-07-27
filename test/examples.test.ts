import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExamples } from "../scripts/generate-examples";
import { loadWorkflow } from "../src/workflow/load";
import type { WorkflowsConfig } from "../src/config";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const EXAMPLES_DIR = join(import.meta.dir, "..", "examples");

const config: WorkflowsConfig = {
  profiles: {
    claude: { kind: "claude" },
    codex: { kind: "codex" },
  },
  default_profile: "claude",
  transcripts: {},
};

async function mirrorExamples(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-examples-"));
  dirs.push(root);
  const dest = join(root, ".hwf", "workflows");
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(EXAMPLES_DIR)) {
    if (!name.endsWith(".yaml")) continue;
    await writeFile(join(dest, name), await readFile(join(EXAMPLES_DIR, name), "utf8"));
  }
  return root;
}

describe("shipped examples", () => {
  test("every example and background workflow loads through the real loader", async () => {
    const root = await mirrorExamples();
    const names = (await readdir(EXAMPLES_DIR))
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const workflow = await loadWorkflow(name, root, config);
      expect(workflow.version).toBe("v1alpha1");
      expect(workflow.steps.length).toBeGreaterThan(0);
    }
  });

  test("example gallery cards build without legacy keys", async () => {
    const cards = await buildExamples(EXAMPLES_DIR);
    expect(cards.map((c) => c.name).sort()).toEqual([
      "handoff",
      "prompt-enhance",
      "review",
      "worktree",
    ]);
    for (const card of cards) {
      expect(card.desc.length).toBeGreaterThan(0);
      expect(card.payload.length).toBeGreaterThan(0);
      for (const file of card.files) {
        expect(file.body).toContain("version: v1alpha1");
        expect(file.body).not.toMatch(/^\s*out:/m);
        expect(file.body).not.toMatch(/^\s*wait:/m);
        expect(file.body).not.toMatch(/^\s*allow_fail:/m);
        expect(file.body).not.toMatch(/^\s*on_error:/m);
        expect(file.body).not.toContain("{session}");
        expect(file.body).not.toMatch(/^\s*use:/m);
      }
    }
  });
});
