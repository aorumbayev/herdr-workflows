import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflows } from "../../src/workflow/inputs-exchange";
import {
  analyzeRawWorkflow,
  analyzeResolvedSensitivity,
  sensitivityLabels,
} from "../../src/workflow/grammar";
import { parseRaw } from "../../src/workflow/grammar";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const V1 = "version: v1alpha1\n";

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-trust-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.yaml`), body);
  }
  return root;
}

describe("analyzeResolvedSensitivity", () => {
  test("parent of a command-running child is flagged commands", async () => {
    const root = await repoWith({
      child: `${V1}steps:\n  - run: [echo, hi]\n`,
      parent: `${V1}steps:\n  - workflow: child\n`,
    });
    const parent = parseRaw(
      "parent.yaml",
      await Bun.file(join(root, ".hwf/workflows/parent.yaml")).text(),
    );
    const flags = await analyzeResolvedSensitivity(
      { name: "parent", steps: parent.steps, returns: parent.returns, onFailure: parent.onFailure },
      root,
    );
    expect(flags.hasCommands).toBe(true);
    expect(sensitivityLabels(flags)).toContain("commands");
    expect(analyzeRawWorkflow(parent).hasCommands).toBe(false);
  });

  test("parent surfaces transcript when only the child references it", async () => {
    const root = await repoWith({
      child: `${V1}steps:\n  - agent: "see {{context.transcript}}"\n    using: claude\n`,
      parent: `${V1}steps:\n  - workflow: child\n`,
    });
    const parent = parseRaw(
      "parent.yaml",
      await Bun.file(join(root, ".hwf/workflows/parent.yaml")).text(),
    );
    const flags = await analyzeResolvedSensitivity(
      { name: "parent", steps: parent.steps, returns: parent.returns, onFailure: parent.onFailure },
      root,
    );
    expect(flags.hasTranscript).toBe(true);
    expect(sensitivityLabels(flags)).toContain("transcript");
  });

  test("unresolved child is flagged instead of reporting clean", async () => {
    const root = await repoWith({
      parent: `${V1}steps:\n  - workflow: missing-child\n`,
    });
    const parent = parseRaw(
      "parent.yaml",
      await Bun.file(join(root, ".hwf/workflows/parent.yaml")).text(),
    );
    const flags = await analyzeResolvedSensitivity(
      { name: "parent", steps: parent.steps, returns: parent.returns, onFailure: parent.onFailure },
      root,
    );
    expect(flags.hasCommands).toBe(false);
    expect(flags.unresolvedChildren).toEqual(["missing-child"]);
    expect(sensitivityLabels(flags)).toContain("unresolved:missing-child");
  });

  test("cycles do not loop and still surface reachable sensitivity", async () => {
    const root = await repoWith({
      a: `${V1}steps:\n  - workflow: b\n  - run: [echo, a]\n`,
      b: `${V1}steps:\n  - workflow: a\n`,
    });
    const a = parseRaw("a.yaml", await Bun.file(join(root, ".hwf/workflows/a.yaml")).text());
    const flags = await analyzeResolvedSensitivity(
      { name: "a", steps: a.steps, returns: a.returns, onFailure: a.onFailure },
      root,
    );
    expect(flags.hasCommands).toBe(true);
  });

  test("listWorkflows aggregates child sensitivity onto the parent entry", async () => {
    const root = await repoWith({
      child: `${V1}steps:\n  - herdr: pane.close\n    params: { pane_id: "w1:p1" }\n`,
      parent: `${V1}steps:\n  - workflow: child\n`,
    });
    const entries = await listWorkflows(root, {
      profiles: { claude: { kind: "claude" } },
      transcripts: {},
    });
    const parent = entries.find((e) => e.name === "parent");
    expect(parent?.sensitiveMethods).toContain("pane.close");
    expect(parent?.hasCommands).toBe(false);
  });
});
