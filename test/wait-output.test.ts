import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitOutput } from "../src/adapter/client";

// Fake herdr that records argv, so we pin the CLI shape without a live server.
// Regression guard: herdr 0.7.5 removed top-level `wait`; must call `pane wait-output`.
async function withFakeHerdr(exitCode: number, run: () => Promise<void>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-wo-"));
  const argsFile = join(dir, "args.json");
  const bin = join(dir, "herdr");
  await writeFile(
    bin,
    `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(Bun.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
  );
  await chmod(bin, 0o755);
  const prev = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = bin;
  try {
    await run();
    return JSON.parse(await readFile(argsFile, "utf8")) as string[];
  } finally {
    if (prev === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("waitOutput", () => {
  test("calls `pane wait-output` with pattern as --regex value and ms timeout", async () => {
    const args = await withFakeHerdr(0, () => waitOutput("w-pane-1", "DONE.*", 60_000));
    expect(args).toEqual([
      "pane",
      "wait-output",
      "--regex",
      "DONE.*",
      "w-pane-1",
      "--timeout",
      "60000",
    ]);
  });

  test("throws HerdrError on non-zero exit", async () => {
    await expect(withFakeHerdr(1, () => waitOutput("w-pane-1", "x", 1000))).rejects.toEqual(
      expect.objectContaining({ name: "HerdrError", code: "wait_output_failed" }),
    );
  });
});
