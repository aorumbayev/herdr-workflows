import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("stdin prompt reader", () => {
  test("releaseStdinReader lets the process exit while stdin stays open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-stdin-release-"));
    const consoleMod = join(import.meta.dir, "..", "src", "console.ts");
    const script = join(dir, "read.ts");
    await writeFile(
      script,
      `import { readLine, releaseStdinReader } from ${JSON.stringify(consoleMod)};
const line = await readLine();
if (line.kind !== "line" || line.text !== "ok") process.exit(2);
await releaseStdinReader();
`,
    );
    try {
      const proc = Bun.spawn([process.execPath, script], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc.stdin.write("ok\n");
      const code = await Promise.race([
        proc.exited,
        Bun.sleep(2_000).then(async () => {
          proc.kill();
          await proc.exited.catch(() => undefined);
          return -1;
        }),
      ]);
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
