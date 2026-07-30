import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("detached run stdio", () => {
  test("a run outlives the picker that read its progress pipe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-epipe-"));
    const sentinel = join(dir, "step-2-ran");
    await mkdir(join(dir, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".hwf", "workflows", "epipe.yaml"),
      `version: v1alpha1
title: Epipe
description: two blocking steps, so the reader can leave between them
steps:
  - run: ["sleep", "1"]
  - run: ["touch", ${JSON.stringify(sentinel)}]
`,
    );
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    try {
      const proc = Bun.spawn(
        ["sh", "-c", `'${process.execPath}' '${cli}' run epipe --launch-payload | head -1`],
        {
          cwd: dir,
          env: { ...process.env, HERDR_WORKFLOWS_REPO_ROOT: dir },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      proc.stdin.write(JSON.stringify({ name: "epipe", inputs: {} }));
      proc.stdin.end();
      await proc.exited;
      expect(await Bun.file(sentinel).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a non-EPIPE standard-stream error remains fatal", async () => {
    const herdr = join(import.meta.dir, "..", "src", "herdr.ts");
    const script = `import { tolerateClosedStdio } from ${JSON.stringify(herdr)};
tolerateClosedStdio();
process.stdout.emit("error", Object.assign(new Error("stream failed"), { code: "EACCES" }));`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("stream failed");
  });
});
