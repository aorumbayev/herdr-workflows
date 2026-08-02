import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExamples, renderModule } from "../../scripts/generate-examples";
import { loadWorkflow } from "../../src/workflow/inputs";
import type { WorkflowsConfig } from "../../src/context";

const committedGallery = join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  ".vitepress",
  "theme",
  "examples.generated.ts",
);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const EXAMPLES_DIR = join(import.meta.dir, "..", "..", "examples");

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
  test("every example loads through the real loader", async () => {
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

  test("handoff step 1 references transcript_file, not transcript", async () => {
    const root = await mirrorExamples();
    const workflow = await loadWorkflow("handoff", root, {
      ...config,
      profiles: { ...config.profiles, opencode: { kind: "opencode" } },
    });
    const brief = workflow.steps[0];
    expect(brief?.action.kind).toBe("agent");
    if (brief?.action.kind !== "agent") throw new Error("expected agent");
    expect(brief.action.prompt).toContain("{{context.transcript_file}}");
    expect(brief.action.prompt).not.toContain("{{context.transcript}}");
    expect(brief.action.prompt).not.toMatch(/\{\{context\.transcript\}\}/);
  });

  test("example gallery cards build without legacy keys", async () => {
    const cards = await buildExamples(EXAMPLES_DIR);
    expect(cards.map((c) => c.name).sort()).toEqual(["branch-check", "handoff", "prompt-enhance"]);
    for (const card of cards) {
      expect(card.desc.length).toBeGreaterThan(0);
      expect(card.payload.length).toBeGreaterThan(0);
      expect(card.body).toContain("version: v1alpha1");
      expect(card.body).not.toMatch(/^\s*out:/m);
      expect(card.body).not.toMatch(/^\s*wait:/m);
      expect(card.body).not.toMatch(/^\s*allow_fail:/m);
      expect(card.body).not.toMatch(/^\s*on_error:/m);
      expect(card.body).not.toContain("{session}");
      expect(card.body).not.toMatch(/^\s*use:/m);
    }
  });

  test("docs/.vitepress/theme/examples.generated.ts matches buildExamples()", async () => {
    const expected = renderModule(await buildExamples(EXAMPLES_DIR));
    if ((await Bun.file(committedGallery).text()) !== expected) {
      throw new Error(
        "docs/.vitepress/theme/examples.generated.ts is stale — run `bun run examples`",
      );
    }
  });

  test("docs/examples.md mounts ExampleCards and does not embed YAML", async () => {
    const page = await Bun.file(join(import.meta.dir, "..", "..", "docs", "examples.md")).text();
    expect(page).toContain("<ExampleCards");
    expect(page).not.toMatch(/```ya?ml/);
  });

  test("docs home lists only shipped example names", async () => {
    const home = await Bun.file(
      join(import.meta.dir, "..", "..", "docs", ".vitepress", "theme", "HomePage.vue"),
    ).text();
    const cards = await buildExamples(EXAMPLES_DIR);
    for (const card of cards) {
      expect(home).toContain(card.name);
    }
    expect(home).not.toMatch(/\bworktree\b/);
    expect(home).not.toMatch(/\breview\b/);
  });
});
