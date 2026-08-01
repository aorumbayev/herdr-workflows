import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../../src/context";
import { loadWorkflow } from "../../src/workflow/load";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SKILL_ROOT = join(import.meta.dir, "..", "..", "skills", "herdr-workflow-create");
const FENCE_RE = /```yaml\n([\s\S]*?)```/g;

const config: WorkflowsConfig = {
  profiles: {
    claude: { kind: "claude" },
    codex: { kind: "codex" },
  },
  default_profile: "claude",
  transcripts: {},
};

type Snippet = {
  file: string;
  index: number;
  name: string;
  body: string;
};

function stripLeadingComments(text: string): { nameHint?: string; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  let nameHint: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const comment = /^#\s*(.+?)\s*$/.exec(line);
    if (!comment) break;
    const hint = comment[1]!;
    if (hint.endsWith(".yaml") && !nameHint) nameHint = hint.replace(/\.yaml$/, "");
    i += 1;
  }
  return { ...(nameHint !== undefined ? { nameHint } : {}), body: lines.slice(i).join("\n") };
}

function isV1alpha1Workflow(body: string): boolean {
  const first = body.trimStart().split("\n")[0] ?? "";
  return /^version:\s*v1alpha1\b/.test(first);
}

async function collectSkillMarkdown(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) out.push(path);
    }
  };
  await walk(SKILL_ROOT);
  return out.sort();
}

async function extractSnippets(): Promise<Snippet[]> {
  const snippets: Snippet[] = [];
  let auto = 0;
  for (const file of await collectSkillMarkdown()) {
    const text = await readFile(file, "utf8");
    FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = FENCE_RE.exec(text))) {
      index += 1;
      const raw = match[1] ?? "";
      const { nameHint, body } = stripLeadingComments(raw);
      if (!isV1alpha1Workflow(body)) continue;
      auto += 1;
      const name = nameHint ?? `skill-snippet-${auto}`;
      snippets.push({
        file: file.slice(SKILL_ROOT.length + 1),
        index,
        name,
        body: nameHint ? `${raw.trim()}\n` : body.trimEnd() + "\n",
      });
    }
  }
  return snippets;
}

describe("herdr-workflow-create skill snippets", () => {
  test("every v1alpha1 yaml fence loads through the real loader", async () => {
    const snippets = await extractSnippets();
    expect(snippets.length).toBeGreaterThan(0);

    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-skill-"));
    dirs.push(root);
    const dest = join(root, ".hwf", "workflows");
    await mkdir(dest, { recursive: true });

    const used = new Map<string, string>();
    for (const snippet of snippets) {
      let name = snippet.name;
      if (used.has(name)) name = `${name}-${snippet.index}`;
      used.set(name, snippet.file);
      await writeFile(join(dest, `${name}.yaml`), snippet.body);
      snippet.name = name;
    }

    for (const snippet of snippets) {
      try {
        const workflow = await loadWorkflow(snippet.name, root, config);
        expect(workflow.version).toBe("v1alpha1");
        expect(workflow.steps.length).toBeGreaterThan(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${snippet.file} snippet #${snippet.index}: ${message}`);
      }
    }
  });
});
