import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInputSession } from "../../src/workflow/inputs";
import type { InputSpec } from "../../src/workflow/grammar";

const dirs: string[] = [];
const prevPluginConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevPluginConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevPluginConfig;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-input-session-"));
  dirs.push(root);
  await mkdir(join(root, ".hwf"), { recursive: true });
  return root;
}

describe("InputSession", () => {
  test("backtrack then change earlier answer invalidates later answers", async () => {
    const specs: InputSpec[] = [
      { name: "mode", type: "choice", options: ["create", "delete"] },
      { name: "branch", type: "choice", options: ["main", "dev"] },
      { name: "note", type: "text" },
    ];
    const session = createInputSession({
      specs,
      file: "x.yaml",
      config: { profiles: {}, transcripts: {} },
      repoRoot: await tempRoot(),
    });

    expect((await session.current()).status).toBe("prompt");
    expect(session.answer("create")).toEqual({ ok: true });
    expect((await session.current()).status).toBe("prompt");
    expect(session.answer("main")).toEqual({ ok: true });
    expect((await session.current()).status).toBe("prompt");
    expect(session.answer("hello")).toEqual({ ok: true });
    expect(session.values).toEqual({ mode: "create", branch: "main", note: "hello" });

    // First back reopens the last answered input (value kept for restore).
    expect(session.back()).toBe(true);
    expect(session.values).toEqual({ mode: "create", branch: "main", note: "hello" });
    // Second back clears later answers.
    expect(session.back()).toBe(true);
    expect(session.values).toEqual({ mode: "create", branch: "main" });
    expect(session.back()).toBe(true);
    expect(session.values).toEqual({ mode: "create" });

    const again = await session.current();
    expect(again.status).toBe("prompt");
    if (again.status === "prompt") expect(again.prompt.spec.name).toBe("mode");
    expect(session.answer("delete")).toEqual({ ok: true });
    expect(session.values).toEqual({ mode: "delete" });
    expect(Object.hasOwn(session.values, "branch")).toBe(false);
    expect(Object.hasOwn(session.values, "note")).toBe(false);
  });

  test("rejects out-of-domain choice values", async () => {
    const session = createInputSession({
      specs: [{ name: "mode", type: "choice", options: ["fast", "full"] }],
      file: "x.yaml",
      config: { profiles: {}, transcripts: {} },
      repoRoot: await tempRoot(),
    });
    expect((await session.current()).status).toBe("prompt");
    expect(session.answer("turbo")).toEqual({
      ok: false,
      error: "input 'mode' must be one of: fast, full",
    });
    expect(session.answer("fast")).toEqual({ ok: true });
  });

  test("empty profile config fails current() with config paths", async () => {
    const root = await tempRoot();
    const plugin = await mkdtemp(join(tmpdir(), "hwf-input-session-plugin-"));
    dirs.push(plugin);
    process.env.HERDR_PLUGIN_CONFIG_DIR = plugin;
    const session = createInputSession({
      specs: [{ name: "target", type: "profile" }],
      file: "x.yaml",
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
    });
    const cur = await session.current();
    expect(cur.status).toBe("error");
    if (cur.status === "error") {
      expect(cur.error).toContain("input 'target': no profiles configured");
      expect(cur.error).toContain("hwf init");
    }
  });

  test("allow_custom bypasses domain membership", async () => {
    const session = createInputSession({
      specs: [
        {
          name: "branch",
          type: "choice",
          options: ["main"],
          allowCustom: true,
          minLength: 1,
        },
      ],
      file: "x.yaml",
      config: { profiles: {}, transcripts: {} },
      repoRoot: await tempRoot(),
    });
    expect((await session.current()).status).toBe("prompt");
    expect(session.answer("feature/x")).toEqual({ ok: true });
    expect(session.result()).toEqual({
      ok: true,
      values: { branch: "feature/x" },
      domains: {},
    });
  });

  test("cancelPending ignores late dynamic option resolution", async () => {
    const root = await tempRoot();
    const script = join(root, "slow.sh");
    await writeFile(script, "#!/bin/sh\nsleep 0.2\necho one\n", { mode: 0o755 });
    const session = createInputSession({
      specs: [
        {
          name: "branch",
          type: "choice",
          dynamicOptions: { run: ["sh", script] },
        },
      ],
      file: join(root, "x.yaml"),
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      resolveDynamic: true,
    });
    const pending = session.current();
    session.cancelPending();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(session.domains).toEqual({});
  });
});
