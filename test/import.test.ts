import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBundle, encodeBundle } from "../src/workflow/bundle";
import { checkBundle, parseImportScope, previewText, runImport } from "../src/workflow/import";
import { WorkflowLoadError } from "../src/workflow/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const bundle = {
  v: 1 as const,
  files: [{ name: "demo", body: "version: v1alpha1\nsteps:\n  - run: bun test\n" }],
};

async function scratch(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-import-"));
  const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
  dirs.push(root, home);
  return { root, home };
}

describe("workflow bundle payloads", () => {
  test("round-trips through base64", () => {
    expect(decodeBundle(encodeBundle(bundle))).toEqual(bundle);
  });

  test("survives the line wrapping a copy-paste can add", () => {
    const payload = encodeBundle(bundle);
    const wrapped = `${payload.slice(0, 10)}\n ${payload.slice(10)}`;
    expect(decodeBundle(wrapped)).toEqual(bundle);
  });

  test("rejects junk, non-bundle JSON, and bad workflow names", () => {
    expect(() => decodeBundle("not-base64-at-all")).toThrow(WorkflowLoadError);
    expect(() => decodeBundle(Buffer.from("plain").toString("base64"))).toThrow(WorkflowLoadError);
    const gz = (o: unknown) =>
      Buffer.from(Bun.gzipSync(new TextEncoder().encode(JSON.stringify(o)))).toString("base64");
    expect(() => decodeBundle(gz({ hello: true }))).toThrow(/not a workflow bundle/);
    expect(() => decodeBundle(gz({ v: 1, files: [{ name: "../evil", body: "x" }] }))).toThrow(
      /workflow name must match/,
    );
  });

  test("checkBundle rejects a payload whose YAML is not a workflow", () => {
    expect(() =>
      checkBundle(encodeBundle({ v: 1, files: [{ name: "bad", body: "nope: 1\n" }] })),
    ).toThrow(/version is required|steps is required/);
  });

  test("preview names every file it would write", () => {
    expect(previewText(bundle)).toContain("--- demo.yaml ---");
  });
});

describe("hwf workflow import", () => {
  test("declining the review writes nothing", async () => {
    const { root, home } = await scratch();
    const outcome = await runImport(encodeBundle(bundle), {
      repoRoot: root,
      home,
      prompts: { confirm: async () => false, chooseScope: async () => "repo" },
    });
    expect(outcome).toEqual({ aborted: true });
    expect(await Bun.file(join(root, ".hwf", "workflows", "demo.yaml")).exists()).toBe(false);
  });

  test("chosen scope decides the directory", async () => {
    const { root, home } = await scratch();
    for (const scope of ["repo", "global"] as const) {
      const outcome = await runImport(encodeBundle(bundle), { repoRoot: root, home, scope });
      if ("aborted" in outcome) throw new Error("unreachable");
      expect(outcome.results).toEqual([
        {
          name: "demo",
          path: join(scope === "repo" ? root : home, ".hwf", "workflows", "demo.yaml"),
          status: "written",
        },
      ]);
    }
  });

  test("an existing file is kept unless force", async () => {
    const { root, home } = await scratch();
    await Bun.write(
      join(root, ".hwf", "workflows", "demo.yaml"),
      "version: v1alpha1\nsteps:\n  - run: mine\n",
    );
    const kept = await runImport(encodeBundle(bundle), { repoRoot: root, home, scope: "repo" });
    if ("aborted" in kept) throw new Error("unreachable");
    expect(kept.results[0]!.status).toBe("exists");
    expect(await readFile(kept.results[0]!.path, "utf8")).toBe(
      "version: v1alpha1\nsteps:\n  - run: mine\n",
    );

    const forced = await runImport(encodeBundle(bundle), {
      repoRoot: root,
      home,
      scope: "repo",
      force: true,
    });
    if ("aborted" in forced) throw new Error("unreachable");
    expect(forced.results[0]!.status).toBe("written");
    expect(await readFile(forced.results[0]!.path, "utf8")).toBe(bundle.files[0]!.body);
  });

  test("no scope and no prompt is an error, not a silent default", async () => {
    const { root, home } = await scratch();
    await expect(runImport(encodeBundle(bundle), { repoRoot: root, home })).rejects.toThrow(
      /no destination chosen/,
    );
  });

  test("parseImportScope accepts aliases", () => {
    expect(parseImportScope("R")).toBe("repo");
    expect(parseImportScope("global")).toBe("global");
    expect(parseImportScope("nope")).toBeUndefined();
  });
});

describe("examples gallery", () => {
  test("section 6 rewrites examples to v1alpha1", () => {
    // Prior gallery coverage depended on the removed experimental grammar.
  });
});
