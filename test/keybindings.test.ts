import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install-keybindings.mjs");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runInstall(
  config: string | null,
): Promise<{ code: number; stdout: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-keys-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  if (config !== null) await writeFile(path, config);
  const proc = Bun.spawn(["node", SCRIPT], {
    env: {
      ...process.env,
      HERDR_CONFIG_PATH: path,
      HERDR_BIN_PATH: join(dir, "missing-herdr"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout, path };
}

describe("install-keybindings", () => {
  test("prefix+k launch binding is idempotent", async () => {
    const first = await runInstall("");
    expect(first.code).toBe(0);
    let text = await readFile(first.path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).toContain('key = "prefix+k"');
    expect(text).not.toContain("herdr-workflows.results");

    const again = await runInstall(text);
    expect(again.stdout).toContain("already present");
    expect(await readFile(again.path, "utf8")).toBe(text);
    expect((text.match(/herdr-workflows\.launch/g) ?? []).length).toBe(1);
  });

  test("strips retired results and legacy kagan/lembas launch", async () => {
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
    const result = await runInstall(stale);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed dead");
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("herdr-workflows.launch");
    expect(text).not.toContain("kagan.launch");
    expect(text).not.toContain("lembas.launch");
    expect(text).not.toContain("herdr-workflows.results");
    expect(text).not.toContain("prefix+r");
  });
});
