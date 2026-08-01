import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCliCommands,
  installKeybindings,
  stripDeadBindings,
  readOwnership,
  resolveBinDir,
  resolveHerdrConfigPath,
} from "../../src/cli";
import { PRODUCT_VERSION } from "../../src/context";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeExecutable(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
}

async function writeRecordingHerdr(dir: string): Promise<{ bin: string; log: string }> {
  const log = join(dir, "herdr-argv.log");
  const bin = await writeExecutable(
    join(dir, "fake-herdr"),
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}
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
  return { bin, log };
}

describe("setup paths", () => {
  test("bin dir prefers XDG_BIN_HOME", () => {
    const custom = join(tmpdir(), "hwf-custom-bin");
    expect(resolveBinDir({ XDG_BIN_HOME: custom })).toBe(custom);
  });

  test("Herdr config prefers HERDR_CONFIG_PATH then XDG path", () => {
    expect(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/c.toml" })).toBe("/tmp/c.toml");
    expect(resolveHerdrConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "herdr", "config.toml"),
    );
  });
});

describe("cli install", () => {
  test("fresh and repeated setup replaces only owned entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-cli-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    const pluginBin = join(root, "plugin", "bin");
    await mkdir(pluginBin, { recursive: true });
    const source = join(pluginBin, "herdr-workflows");
    await writeFile(source, "fake-binary\n");

    const first = installCliCommands({
      binDir,
      binary: source,
      ephemeral: false,
    });
    expect(
      first.messages.some(
        (m) => m.includes("install") || m.includes("linked") || m.includes("copied"),
      ),
    ).toBe(true);

    expect(readOwnership(binDir).entries["herdr-workflows"]).toBeDefined();
    expect(readOwnership(binDir).entries.hwf).toBeDefined();

    await writeFile(source, "fake-binary-v2\n");
    const second = installCliCommands({
      binDir,
      binary: source,
      ephemeral: false,
    });
    expect(second.messages.length).toBeGreaterThan(0);
    expect(readOwnership(binDir).entries["herdr-workflows"]).toEqual({
      kind: "symlink",
      version: PRODUCT_VERSION,
      source,
    });
  });

  test("foreign entry is preserved and named", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-foreign-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const foreign = join(binDir, "herdr-workflows");
    await writeFile(foreign, "not-ours\n");
    const source = join(root, "source-bin");
    await writeFile(source, "ours\n");

    const result = installCliCommands({
      binDir,
      binary: source,
      ephemeral: false,
    });
    expect(result.messages.some((m) => m.includes("not owned"))).toBe(true);
    expect(await readFile(foreign, "utf8")).toBe("not-ours\n");
  });

  test("retargeted owned symlink is preserved as foreign", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-retargeted-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    const source = join(root, "source-bin");
    const foreign = join(root, "foreign-bin");
    await writeFile(source, "ours\n");
    await writeFile(foreign, "foreign\n");

    installCliCommands({ binDir, binary: source, ephemeral: false });
    const hwf = join(binDir, "hwf");
    await rm(hwf);
    symlinkSync(foreign, hwf);

    const result = installCliCommands({ binDir, binary: source, ephemeral: false });
    expect(result.messages).toContain(
      `skipped cli install: ${hwf} exists and is not owned by herdr-workflows`,
    );
    expect(await readFile(hwf, "utf8")).toBe("foreign\n");
  });

  test("ephemeral setup copies the binary once and symlinks hwf to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-single-copy-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    const pluginBin = join(root, "plugin", "bin");
    await mkdir(pluginBin, { recursive: true });
    const source = join(pluginBin, "herdr-workflows");
    await writeFile(source, "fake-binary\n");

    installCliCommands({ binDir, binary: source, ephemeral: true });

    const primary = join(binDir, "herdr-workflows");
    const hwf = join(binDir, "hwf");
    expect(lstatSync(primary).isSymbolicLink()).toBe(false);
    expect(lstatSync(hwf).isSymbolicLink()).toBe(true);
    expect(readlinkSync(hwf)).toBe(primary);
    expect(await readFile(hwf, "utf8")).toBe("fake-binary\n");
    expect(readOwnership(binDir).entries.hwf?.kind).toBe("symlink");
  });

  test("ephemeral setup with foreign primary copies hwf instead of dangling", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-foreign-primary-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "herdr-workflows"), "not-ours\n");
    const pluginBin = join(root, "plugin", "bin");
    await mkdir(pluginBin, { recursive: true });
    const source = join(pluginBin, "herdr-workflows");
    await writeFile(source, "fake-binary\n");

    const result = installCliCommands({ binDir, binary: source, ephemeral: true });

    expect(result.messages.some((m) => m.includes("not owned"))).toBe(true);
    const hwf = join(binDir, "hwf");
    expect(lstatSync(hwf).isSymbolicLink()).toBe(false);
    expect(await readFile(hwf, "utf8")).toBe("fake-binary\n");
  });

  test("ephemeral setup preserves foreign files and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-setup-ephemeral-"));
    dirs.push(root);
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const foreignFile = join(binDir, "herdr-workflows");
    const foreignLink = join(binDir, "hwf");
    const elsewhere = join(root, "foreign-target");
    await writeFile(foreignFile, "foreign-file\n");
    await writeFile(elsewhere, "foreign-link-target\n");
    symlinkSync(elsewhere, foreignLink);
    const source = join(root, "source-bin");
    await writeFile(source, "ours\n");

    const result = installCliCommands({
      binDir,
      binary: source,
      ephemeral: true,
    });
    expect(result.messages.filter((m) => m.includes("not owned"))).toHaveLength(2);
    expect(await readFile(foreignFile, "utf8")).toBe("foreign-file\n");
    expect(await readFile(foreignLink, "utf8")).toBe("foreign-link-target\n");
  });

  test("PATH warning is produced by callers when bin dir is absent", () => {
    const missing = resolveBinDir({ XDG_BIN_HOME: join(tmpdir(), "hwf-missing-bin-xyz") });
    expect(missing).toContain("hwf-missing-bin-xyz");
  });
});

describe("keybinding install", () => {
  test("prefix+k launch binding is idempotent and calls config check + reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-bin-"));
    dirs.push(dir);
    const { bin: herdrBin, log: logPath } = await writeRecordingHerdr(dir);
    const path = join(dir, "config.toml");
    await writeFile(path, "");
    await writeFile(logPath, "");

    const first = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: herdrBin,
      },
    });
    expect(first.messages.join("\n")).toContain("herdr-workflows.launch");
    const text = await readFile(path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).toContain('key = "prefix+k"');
    expect(text).not.toContain("herdr-workflows.results");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("config check");
    expect(log).toContain("server reload-config");
    expect(first.messages.join("\n")).toContain("herdr reloaded config");

    await writeFile(logPath, "");
    const again = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: herdrBin,
      },
    });
    expect(again.messages.join("\n")).toContain("already present");
    expect(await readFile(path, "utf8")).toBe(text);
    expect((text.match(/herdr-workflows\.launch/g) ?? []).length).toBe(1);
    expect(await readFile(logPath, "utf8")).toBe("");
  });

  test("strips retired results and legacy kagan/lembas launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-bin-"));
    dirs.push(dir);
    const { bin: herdrBin, log: logPath } = await writeRecordingHerdr(dir);
    const path = join(dir, "config.toml");
    const stale = `# keep me

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
    await writeFile(path, stale);
    await writeFile(logPath, "");
    const result = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: herdrBin,
      },
    });
    expect(result.messages.join("\n")).toContain("removed dead");
    const text = await readFile(path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).not.toContain("kagan.launch");
    expect(text).not.toContain("lembas.launch");
    expect(text).not.toContain("herdr-workflows.results");
    expect(text).not.toContain("prefix+r");

    const again = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: herdrBin,
      },
    });
    expect(again.messages.join("\n")).toContain("already present");
    expect(await readFile(path, "utf8")).toBe(text);
    expect(await readFile(`${path}.hwf.bak`, "utf8")).toBe(stale);
  });

  test("missing herdr validator does not write config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-miss-"));
    dirs.push(dir);
    const path = join(dir, "config.toml");
    const original = "# keep me\n";
    await writeFile(path, original);
    const result = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: join(dir, "missing-herdr"),
      },
      reload: false,
    });
    expect(result.messages.join("\n")).toContain("config check failed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await Bun.file(`${path}.hwf.tmp`).exists()).toBe(false);
  });

  test("stripDeadBindings removes only retired tables", () => {
    const text = `
[[keys.command]]
command = "keep.me"

[[keys.command]]
command = "herdr-workflows.results"
`;
    const cleaned = stripDeadBindings(text);
    expect(cleaned).toContain("keep.me");
    expect(cleaned).not.toContain("herdr-workflows.results");
  });

  test("reload-config failure is reported without claiming the running Herdr loaded the binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-reload-"));
    dirs.push(dir);
    const log = join(dir, "herdr-argv.log");
    const herdrBin = await writeExecutable(
      join(dir, "fake-herdr"),
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = config ] && [ "$2" = check ]; then
  echo "config: ok"
  exit 0
fi
if [ "$1" = server ] && [ "$2" = reload-config ]; then
  echo "reload denied" >&2
  exit 3
fi
exit 1
`,
    );
    const path = join(dir, "config.toml");
    await writeFile(path, "");
    const result = installKeybindings({
      env: {
        ...process.env,
        HERDR_CONFIG_PATH: path,
        HERDR_BIN_PATH: herdrBin,
      },
    });
    const joined = result.messages.join("\n");
    expect(joined).toContain("herdr-workflows.launch");
    expect(joined).toContain("reload-config failed");
    expect(joined).toContain("may not have loaded the binding");
    expect(joined).not.toContain("herdr reloaded config");
    expect(await readFile(path, "utf8")).toContain("herdr-workflows.launch");
  });
});
