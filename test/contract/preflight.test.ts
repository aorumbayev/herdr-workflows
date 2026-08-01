import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const PREFLIGHT = join(import.meta.dir, "..", "..", "scripts", "preflight.sh");

async function runWithPath(extraBin: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["sh", PREFLIGHT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${extraBin}:${process.env.PATH ?? ""}`,
    },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code: code ?? 1, stderr };
}

describe("preflight.sh", () => {
  test("passes when host Bun meets the minimum", async () => {
    const proc = Bun.spawn(["sh", PREFLIGHT], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });

  test("fails naming the minimum when bun is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-preflight-"));
    dirs.push(dir);
    const proc = Bun.spawn(["/bin/sh", PREFLIGHT], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: dir },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/requires Bun >= 1\.3/);
    expect(stderr).toMatch(/not found/);
  });

  test("fails naming the minimum when bun is too old", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-preflight-old-"));
    dirs.push(dir);
    const fake = join(dir, "bun");
    await writeFile(fake, "#!/bin/sh\necho 1.2.9\n");
    chmodSync(fake, 0o755);
    const { code, stderr } = await runWithPath(dir);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/requires Bun >= 1\.3/);
    expect(stderr).toMatch(/found 1\.2\.9/);
  });
});
