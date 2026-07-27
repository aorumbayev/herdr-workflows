import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const home = await mkdtemp(join(tmpdir(), "hwf-cli-home-"));
  const state = await mkdtemp(join(tmpdir(), "hwf-cli-state-"));
  dirs.push(home, state);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    HERDR_PLUGIN_STATE_DIR: state,
    ...extraEnv,
  };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_PLUGIN_CONTEXT_JSON;
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("cli run", () => {
  test("run resolves workflows via HERDR_WORKFLOWS_REPO_ROOT from a foreign cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hwf-cli-elsewhere-"));
    dirs.push(root, elsewhere);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], elsewhere, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("run from a foreign cwd without the env var finds nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hwf-cli-elsewhere-"));
    dirs.push(root, elsewhere);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], elsewhere);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("run treats an empty HERDR_WORKFLOWS_REPO_ROOT as unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], root, { HERDR_WORKFLOWS_REPO_ROOT: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });
});
