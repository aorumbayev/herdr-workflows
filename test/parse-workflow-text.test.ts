import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, parseWorkflowText } from "../src/workflows/load";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(name: string, body: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-parse-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.yaml`);
  await writeFile(file, body);
  return { root, file };
}

describe("parseWorkflowText parity", () => {
  test("valid buffer matches file load", async () => {
    const body = `steps:\n  - run: echo hi\n`;
    const { root, file } = await repo("ok", body);
    const fromFile = await loadWorkflow("ok", root);
    const fromText = await parseWorkflowText("ok", body, [], root, file);
    expect(fromText.steps).toEqual(fromFile.steps);
    expect(fromText.needsPrompt).toBe(fromFile.needsPrompt);
  });

  test("invalid buffer produces the same positioned error as file load", async () => {
    const body = `steps:\n  - run: echo {pane}\n`;
    const { root, file } = await repo("bad", body);
    const fileErr = await loadWorkflow("bad", root).catch((e) => (e as Error).message);
    const textErr = await parseWorkflowText("bad", body, [], root, file).catch(
      (e) => (e as Error).message,
    );
    expect(textErr).toBe(fileErr);
    expect(textErr).toMatch(/step 1/);
  });
});
