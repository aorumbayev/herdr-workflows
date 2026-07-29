import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("prepare-release", () => {
  test("updates only the herdr-plugin.toml version field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-prepare-"));
    dirs.push(dir);
    const toml = join(dir, "herdr-plugin.toml");
    await writeFile(toml, `id = "herdr-workflows"\nversion = "0.1.0"\nname = "herdr-workflows"\n`);
    const script = join(import.meta.dir, "..", "scripts", "prepare-release.ts");
    const proc = Bun.spawn(["bun", script, "0.2.0", toml], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("0.2.0");
    expect(await readFile(toml, "utf8")).toBe(
      `id = "herdr-workflows"\nversion = "0.2.0"\nname = "herdr-workflows"\n`,
    );
  });

  test("rejects malformed versions", async () => {
    const script = join(import.meta.dir, "..", "scripts", "prepare-release.ts");
    const proc = Bun.spawn(["bun", script, "v0.2.0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("expected x.y.z");
  });

  test("package.json stays a non-published development package", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      version: string;
      private?: boolean;
      devDependencies: Record<string, string>;
    };
    expect(pkg.version).toBe("0.0.0-development");
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies["@semantic-release/npm"]).toBeUndefined();
    expect(pkg.devDependencies["semantic-release"]).toBeDefined();
  });

  test("release config publishes plain GitHub releases and skips npm", async () => {
    const config = (await import("../release.config.js")).default as {
      branches: string[];
      tagFormat: string;
      plugins: unknown[];
    };
    expect(config.branches).toEqual(["main"]);
    expect(config.tagFormat).toBe("v${version}");
    const flat = JSON.stringify(config.plugins);
    expect(flat).not.toContain("@semantic-release/npm");
    expect(flat).not.toContain("draftRelease");
    expect(flat).toContain("prepare-release.ts");
    expect(flat).toContain("[skip ci]");
    expect(flat).toContain('"breaking":true');
  });

  test("release workflow runs semantic-release only by manual dispatch", () => {
    const yml = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(yml).toContain("bun x semantic-release");
    expect(yml).toContain("bun install --frozen-lockfile");
    expect(yml).toContain("workflow_dispatch:");
    expect(yml).not.toContain("push:");
  });
});
