import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_BYTE_LIMIT } from "../src/limits";
import { defaultShell, killSpawn, shellArgv, spawnCapture } from "../src/run/steps/shell";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("defaultShell", () => {
  test("sh on POSIX, cmd on win32", () => {
    expect(defaultShell("darwin")).toBe("sh");
    expect(defaultShell("linux")).toBe("sh");
    expect(defaultShell("win32")).toBe("cmd");
    expect(defaultShell()).toBe(process.platform === "win32" ? "cmd" : "sh");
  });
});

describe("shellArgv", () => {
  test("follows the platform default", () => {
    expect(shellArgv("echo hi", defaultShell("linux"))).toEqual(["sh", "-c", "echo hi"]);
    expect(shellArgv("echo hi", defaultShell("win32"))).toEqual(["cmd", "/c", "echo hi"]);
  });

  test("explicit shell overrides the default", () => {
    expect(shellArgv("x", "sh")).toEqual(["sh", "-c", "x"]);
    expect(shellArgv("x", "bash")).toEqual(["bash", "-c", "x"]);
    expect(shellArgv("x", "zsh")).toEqual(["zsh", "-c", "x"]);
    expect(shellArgv("x", "pwsh")).toEqual(["pwsh", "-NoProfile", "-Command", "x"]);
    expect(shellArgv("x", "powershell")).toEqual(["powershell", "-NoProfile", "-Command", "x"]);
    expect(shellArgv("x", "cmd")).toEqual(["cmd", "/c", "x"]);
  });
});

describe("killSpawn", () => {
  const realKill = process.kill;
  afterEach(() => {
    process.kill = realKill;
  });

  function spyKill(impl: (...args: unknown[]) => boolean): unknown[][] {
    const calls: unknown[][] = [];
    process.kill = ((...args: unknown[]) => {
      calls.push(args);
      return impl(...args);
    }) as typeof process.kill;
    return calls;
  }

  test("POSIX kills the detached process group", () => {
    const calls = spyKill(() => true);
    let childKilled = false;
    killSpawn({ pid: 4242, kill: () => (childKilled = true) }, "linux");
    expect(calls).toEqual([[-4242, "SIGKILL"]]);
    expect(childKilled).toBe(false);
  });

  test("POSIX falls back to the child when the group is gone", () => {
    spyKill(() => {
      throw new Error("ESRCH");
    });
    let childKilled = false;
    killSpawn({ pid: 4242, kill: () => (childKilled = true) }, "darwin");
    expect(childKilled).toBe(true);
  });

  test("win32 kills only the child — no process groups", () => {
    const calls = spyKill(() => true);
    let childKilled = false;
    killSpawn({ pid: 4242, kill: () => (childKilled = true) }, "win32");
    expect(calls).toEqual([]);
    expect(childKilled).toBe(true);
  });
});

describe("spawnCapture caps", () => {
  test("stderr flood fails against the shared capture budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-stderr-cap-"));
    dirs.push(root);
    await expect(
      spawnCapture(["bun", "-e", `process.stderr.write(Buffer.alloc(${CAPTURE_BYTE_LIMIT + 1}))`], {
        cwd: root,
        maxCaptureBytes: { source: "command" },
      }),
    ).rejects.toThrow(new RegExp(`command exceeded ${CAPTURE_BYTE_LIMIT} byte limit`));
  });
});
