import { afterEach, describe, expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeHostExecutable } from "./host-executable";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "skills",
  "herdr-workflow-create",
  "scripts",
  "validate.sh",
);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function discoverPosixShell(): string | undefined {
  for (const candidate of ["/bin/sh", "sh"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const posixShell = discoverPosixShell();
const describeValidate = posixShell ? describe : describe.skip;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function withHwfPath(): Promise<{ root: string; bin: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "hwf-validate-"));
  dirs.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeHostExecutable(
    join(bin, "hwf"),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"`,
  );
  const plugin = join(root, "plugin-config");
  const state = join(root, "plugin-state");
  await mkdir(plugin, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
  await writeFile(
    join(root, ".hwf", "config.yaml"),
    "profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n",
  );
  return {
    root,
    bin,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      HERDR_WORKFLOWS_REPO_ROOT: root,
      HERDR_PLUGIN_CONFIG_DIR: plugin,
      HERDR_PLUGIN_STATE_DIR: state,
      HOME: join(root, "home"),
    },
  };
}

async function runValidate(
  env: NodeJS.ProcessEnv,
  file: string,
  name?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([posixShell!, SCRIPT, file, ...(name ? [name] : [])], {
    env,
    cwd: env.HERDR_WORKFLOWS_REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describeValidate("validate.sh", () => {
  test("exit 0 for loader-valid YAML", async () => {
    const { root, env } = await withHwfPath();
    const file = join(root, "ok.yaml");
    await writeFile(file, "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n");
    const result = await runValidate(env, file, "ok");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  test("exit 1 for loader-invalid YAML", async () => {
    const { root, env } = await withHwfPath();
    const file = join(root, "bad.yaml");
    await writeFile(file, "version: v1alpha1\nsteps:\n  - run: 'echo {{inputs.x}}'\n");
    const result = await runValidate(env, file, "bad");
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/template/);
  });

  test("exit 2 when hwf is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-validate-miss-"));
    dirs.push(root);
    const emptyPath = join(root, "empty-path");
    await mkdir(emptyPath);
    const file = join(root, "x.yaml");
    await writeFile(file, "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n");
    const result = await runValidate(
      {
        ...process.env,
        PATH: emptyPath,
      },
      file,
      "x",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing dependency");
    expect(result.stderr).toContain("hwf");
  });
});

if (!posixShell) {
  test("validate.sh skipped: POSIX shell not available", () => {
    expect(discoverPosixShell()).toBeUndefined();
  });
}
