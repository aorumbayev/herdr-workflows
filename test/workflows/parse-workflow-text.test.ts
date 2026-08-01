import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../../src/config";
import { loadWorkflow, parseWorkflowText } from "../../src/workflow/load";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const emptyConfig: WorkflowsConfig = { profiles: {}, transcripts: {} };

async function repo(name: string, body: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-parse-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.yaml`);
  await writeFile(file, body);
  return { root, file };
}

const body = `version: v1alpha1\nsteps:\n  - run: echo hi\n`;

describe("parseWorkflowText parity", () => {
  test("valid buffer matches file load", async () => {
    const { root, file } = await repo("ok", body);
    const fromFile = await loadWorkflow("ok", root, emptyConfig);
    const fromText = await parseWorkflowText("ok", body, emptyConfig, root, file);
    expect(fromText.steps).toEqual(fromFile.steps);
    expect(fromText.needsTranscript).toBe(fromFile.needsTranscript);
  });

  test("invalid buffer produces the same positioned error as file load", async () => {
    const bad = `version: v1alpha1\nsteps:\n  - run: "echo {{inputs.missing}}"\n`;
    const { root, file } = await repo("bad", bad);
    const fileErr = await loadWorkflow("bad", root, emptyConfig).catch((e) => (e as Error).message);
    const textErr = await parseWorkflowText("bad", bad, emptyConfig, root, file).catch(
      (e) => (e as Error).message,
    );
    expect(textErr).toBe(fileErr);
  });
});
