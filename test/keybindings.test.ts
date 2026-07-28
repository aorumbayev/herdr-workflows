import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install-keybindings.mjs");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeRecordingHerdr(dir: string): Promise<{ bin: string; log: string }> {
  const bin = join(dir, "fake-herdr");
  const log = join(dir, "herdr-argv.log");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = config ] && [ "$2" = check ]; then
  echo "config: ok"
  exit 0
fi
if [ "$1" = server ] && [ "$2" = reload-config ]; then
  exit 0
fi
exit 1
`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

async function runInstall(opts: {
  config: string | null;
  herdrBin: string;
  logPath: string;
}): Promise<{ code: number; stdout: string; path: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  if (opts.config !== null) await writeFile(path, opts.config);
  await writeFile(opts.logPath, "");
  const proc = Bun.spawn(["node", SCRIPT], {
    env: {
      ...process.env,
      HERDR_CONFIG_PATH: path,
      HERDR_BIN_PATH: opts.herdrBin,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const argvLog = await readFile(opts.logPath, "utf8").catch(() => "");
  return { code, stdout, path, log: argvLog };
}

describe("install-keybindings", () => {
  test("prefix+k launch binding is idempotent and calls config check + reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-bin-"));
    dirs.push(dir);
    const { bin: herdrBin, log: logPath } = await writeRecordingHerdr(dir);

    const first = await runInstall({ config: "", herdrBin, logPath });
    expect(first.code).toBe(0);
    const text = await readFile(first.path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).toContain('key = "prefix+k"');
    expect(text).not.toContain("herdr-workflows.results");
    expect(first.log).toContain("config check");
    expect(first.log).toContain("server reload-config");

    const again = await runInstall({ config: text, herdrBin, logPath });
    expect(again.stdout).toContain("already present");
    expect(await readFile(again.path, "utf8")).toBe(text);
    expect((text.match(/herdr-workflows\.launch/g) ?? []).length).toBe(1);
    expect(again.log).toBe("");
  });

  test("strips retired results and legacy kagan/lembas launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-bin-"));
    dirs.push(dir);
    const { bin: herdrBin, log: logPath } = await writeRecordingHerdr(dir);
    const stale = `
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "kagan.launch"
description = "launch a kagan workflow (picker)"

[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "lembas.launch"
description = "launch lembas"

[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "herdr-workflows.results"
description = "view completed herdr-workflows job results"
`;
    const result = await runInstall({ config: stale, herdrBin, logPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed dead");
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).not.toContain("kagan.launch");
    expect(text).not.toContain("lembas.launch");
    expect(text).not.toContain("herdr-workflows.results");
    expect(text).not.toContain("prefix+r");
    expect(result.log).toContain("config check");
    expect(result.log).toContain("server reload-config");
  });

  test("missing herdr validator does not write config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-miss-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    const original = "# keep me\n";
    await writeFile(path, original);
    const missing = join(dir, "missing-herdr");
    const proc = Bun.spawn(["node", SCRIPT], {
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: missing,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("config check failed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await Bun.file(`${path}.hwf.tmp`).exists()).toBe(false);
  });
});
