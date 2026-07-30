import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTemplateNamespace,
  globalConfigPath,
  loadConfig,
  parseConfigText,
  platformName,
  profileNames,
  repoConfigPath,
  repoLocalConfigPath,
  resolveProfile,
  resolvePluginConfigDir,
} from "../src/config";
import { assertUnderHwfEnvCap, CAPTURE_BYTE_LIMIT, HWF_ENV_BYTE_LIMIT } from "../src/limits";
import { hasTranscriptSupport } from "../src/session";
import {
  parseDynamicChoiceStdout,
  parseWorkflowText,
  resolveDynamicChoices,
} from "../src/workflow/load";
import { collectWorkflowInputs } from "../src/workflow/inputs";
import { workflowNeedsTranscript } from "../src/workflow/parse";

const dirs: string[] = [];
const prevPluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevPluginDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevPluginDir;
});

async function fixture(): Promise<{ plugin: string; root: string }> {
  const plugin = await mkdtemp(join(tmpdir(), "herdr-workflows-plugin-"));
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-repo-"));
  dirs.push(plugin, root);
  process.env.HERDR_PLUGIN_CONFIG_DIR = plugin;
  await mkdir(join(root, ".hwf"), { recursive: true });
  return { plugin, root };
}

describe("profiles config", () => {
  test("local replaces whole committed profile entry", async () => {
    const { plugin, root } = await fixture();
    await writeFile(
      join(plugin, "config.yaml"),
      `profiles:\n  implementation:\n    kind: claude\n    args: ["--model", "global"]\ndefault_profile: implementation\n`,
    );
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `profiles:\n  implementation:\n    kind: claude\n    args: ["--model", "repo"]\n`,
    );
    await writeFile(
      join(root, ".hwf", "config.local.yaml"),
      `profiles:\n  implementation:\n    kind: codex\n`,
    );
    const cfg = await loadConfig(root);
    expect(cfg.profiles.implementation).toEqual({ kind: "codex" });
    expect(cfg.default_profile).toBe("implementation");
  });

  test("highest-precedence default_profile must resolve after merge", async () => {
    const { root } = await fixture();
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n`,
    );
    await writeFile(join(root, ".hwf", "config.local.yaml"), `default_profile: missing\n`);
    await expect(loadConfig(root)).rejects.toThrow(
      new RegExp(
        `${join(root, ".hwf", "config.local.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*default_profile 'missing' is not a merged profile`,
      ),
    );
  });

  test("unresolvable default_profile blames the declaring local layer", async () => {
    const { root } = await fixture();
    await writeFile(join(root, ".hwf", "config.yaml"), `profiles:\n  claude:\n    kind: claude\n`);
    const local = join(root, ".hwf", "config.local.yaml");
    await writeFile(local, `default_profile: nowhere\n`);
    await expect(loadConfig(root)).rejects.toThrow(
      new RegExp(`${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, default_profile:`),
    );
  });

  test("legacy agents and sessions rejected as unknown keys", async () => {
    const { root } = await fixture();
    await writeFile(join(root, ".hwf", "config.yaml"), `agents:\n  claude: [claude]\n`);
    await expect(loadConfig(root)).rejects.toThrow(/Unrecognized key: "agents"/);
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `sessions:\n  claude:\n    command: [echo]\n`,
    );
    await expect(loadConfig(root)).rejects.toThrow(/Unrecognized key: "sessions"/);
  });

  test("profile requires non-empty kind; args optional non-empty list", async () => {
    expect(() => parseConfigText("c.yaml", `profiles:\n  x:\n    kind: ""\n`)).toThrow(/kind/);
    expect(() =>
      parseConfigText("c.yaml", `profiles:\n  x:\n    kind: claude\n    args: []\n`),
    ).toThrow(/args/);
    const ok = parseConfigText(
      "c.yaml",
      `profiles:\n  deep-review:\n    kind: claude\n    args: ["--model", "opus"]\ndefault_profile: deep-review\n`,
    );
    expect(ok.profiles["deep-review"]).toEqual({ kind: "claude", args: ["--model", "opus"] });
  });

  test("profile names match identifier rules", async () => {
    expect(() => parseConfigText("c.yaml", `profiles:\n  Bad:\n    kind: claude\n`)).toThrow(
      /Invalid key in record|profile name/,
    );
  });

  test("transcript extractors replace by kind name", async () => {
    const { plugin, root } = await fixture();
    await writeFile(
      join(plugin, "config.yaml"),
      `transcripts:\n  claude:\n    command: [echo, global]\n  codex:\n    command: [echo, keep]\n`,
    );
    await writeFile(
      join(root, ".hwf", "config.yaml"),
      `transcripts:\n  claude:\n    command: [echo, repo]\n`,
    );
    const cfg = await loadConfig(root);
    expect(cfg.transcripts.claude?.command).toEqual(["echo", "repo"]);
    expect(cfg.transcripts.codex?.command).toEqual(["echo", "keep"]);
    expect(resolveProfile(cfg, "implementation")).toBeUndefined();
    expect(repoLocalConfigPath(root)).toBe(join(root, ".hwf", "config.local.yaml"));
    expect(hasTranscriptSupport("claude", cfg.transcripts)).toBe(true);
    expect(hasTranscriptSupport("codex", cfg.transcripts)).toBe(true);
  });

  test("shared caps and sensitive transcript detection", () => {
    expect(HWF_ENV_BYTE_LIMIT).toBe(24 * 1024);
    expect(() => assertUnderHwfEnvCap("hwf env", "x".repeat(HWF_ENV_BYTE_LIMIT + 1))).toThrow(/24/);
    expect(
      workflowNeedsTranscript([
        {
          action: {
            kind: "agent",
            prompt: "{{context.transcript}}",
          },
        },
      ]),
    ).toBe(true);
    expect(() => parseConfigText("bad.yaml", "agents: {}")).toThrow(/Unrecognized key: "agents"/);
  });

  test("buildTemplateNamespace accepts optional agent", () => {
    const ns = buildTemplateNamespace({
      ctx: { selection: "", cwd: "/repo" },
      agent: "claude",
    });
    expect(ns.context.agent).toBe("claude");
    expect(buildTemplateNamespace({ ctx: { selection: "", cwd: "/repo" } }).context.agent).toBe("");
  });
});

describe("plugin config directory", () => {
  test("HERDR_PLUGIN_CONFIG_DIR wins without calling herdr", async () => {
    const { plugin } = await fixture();
    expect(await resolvePluginConfigDir()).toBe(plugin);
  });

  test("missing env discovers via herdr plugin config-dir", async () => {
    const plugin = await mkdtemp(join(tmpdir(), "herdr-workflows-discovered-"));
    dirs.push(plugin);
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    const fakeBin = join(plugin, "fake-herdr");
    await writeFile(
      fakeBin,
      `#!/bin/sh\nif [ "$1" = plugin ] && [ "$2" = config-dir ] && [ "$3" = herdr-workflows ]; then\n  printf '%s\\n' "${plugin}"\n  exit 0\nfi\nexit 1\n`,
    );
    await Bun.spawn(["chmod", "+x", fakeBin]).exited;
    expect(
      await resolvePluginConfigDir({
        ...process.env,
        HERDR_BIN_PATH: fakeBin,
      }),
    ).toBe(plugin);
  });
});

describe("platformName", () => {
  test("maps process.platform to the two native platform names", () => {
    expect(platformName("darwin")).toBe("macos");
    expect(platformName("linux")).toBe("linux");
    expect(platformName()).toBe(platformName(process.platform));
  });

  test("anything that is not darwin resolves to linux", () => {
    expect(platformName("win32")).toBe("linux");
    expect(platformName("freebsd")).toBe("linux");
  });
});

describe("inputs and profile choices", () => {
  test("profile input lists merged names deterministically without args", async () => {
    const cfg = {
      profiles: {
        zebra: { kind: "codex" },
        alpha: { kind: "claude", args: ["--model", "secret"] },
      },
      transcripts: {},
    };
    expect(profileNames(cfg)).toEqual(["alpha", "zebra"]);
    const wf = await parseWorkflowText(
      "p",
      `version: v1alpha1\ninputs:\n  role: profile\nsteps:\n  - agent: hi\n    using: "{{inputs.role}}"\n`,
      cfg,
    );
    expect(wf.inputs[0]?.type).toBe("profile");
    expect(wf.inputs[0]?.options).toBeUndefined();
  });

  test("active profile input with zero profiles fails collection naming config paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-noprof-"));
    dirs.push(root);
    const plugin = await mkdtemp(join(tmpdir(), "herdr-workflows-plugin-"));
    dirs.push(plugin);
    process.env.HERDR_PLUGIN_CONFIG_DIR = plugin;
    const globalPath = await globalConfigPath();
    const repoPath = repoConfigPath(root);
    const config = { profiles: {}, transcripts: {} };
    const workflow = await parseWorkflowText(
      "handoff",
      `version: v1alpha1\ninputs:\n  target: profile\nsteps:\n  - agent: hi\n    using: "{{inputs.target}}"\n`,
      config,
      root,
    );
    const collected = await collectWorkflowInputs(workflow, { config, repoRoot: root });
    expect(collected.ok).toBe(false);
    if (collected.ok) throw new Error("expected profile collection to fail");
    expect(collected.error).toContain("input 'target': no profiles configured");
    expect(collected.error).toContain(globalPath);
    expect(collected.error).toContain(repoPath);
    expect(collected.error).toContain("hwf init");
    expect(collected.error).toContain("hwf init --global");
  });

  test("unused inputs fail load", async () => {
    await expect(
      parseWorkflowText(
        "u",
        `version: v1alpha1\ninputs:\n  unused: text\nsteps:\n  - run: [echo, hi]\n`,
      ),
    ).rejects.toThrow(/unused input/);
  });

  test("choice default must exist in options", async () => {
    await expect(
      parseWorkflowText(
        "c",
        `version: v1alpha1\ninputs:\n  branch:\n    type: choice\n    default: missing\n    options: [main]\nsteps:\n  - run: [echo, "{{inputs.branch}}"]\n`,
      ),
    ).rejects.toThrow(/default 'missing' is not in available values/);
  });

  test("dynamic choice parsing splits, trims, dedupes", () => {
    expect(parseDynamicChoiceStdout(" main\r\n\nmain\ndev \n")).toEqual(["main", "dev"]);
  });

  test("dynamic choice rejects templates and honors limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-dyn-"));
    dirs.push(root);
    await expect(
      resolveDynamicChoices("f.yaml", "branch", { run: ["echo", "{{inputs.x}}"] }, root),
    ).rejects.toThrow(/rejects templates/);

    await expect(
      resolveDynamicChoices("f.yaml", "branch", { run: ["false"] }, root),
    ).rejects.toThrow(/dynamic choice failed/);

    const many = Array.from({ length: 1001 }, (_, i) => `c${i}`).join("\n");
    await expect(
      resolveDynamicChoices("f.yaml", "branch", { run: ["printf", `%s`, many] }, root),
    ).rejects.toThrow(/limit 1000/);
  });

  test("dynamic choice stdout respects shared capture cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-cap-"));
    dirs.push(root);
    const script = join(root, "big.sh");
    await writeFile(
      script,
      `#!/bin/sh\ndd if=/dev/zero bs=${CAPTURE_BYTE_LIMIT + 1} count=1 2>/dev/null\n`,
    );
    await Bun.spawn(["chmod", "+x", script]).exited;
    await expect(
      resolveDynamicChoices("f.yaml", "branch", { run: [script] }, root),
    ).rejects.toThrow(new RegExp(`exceeded ${CAPTURE_BYTE_LIMIT} byte limit`));
  });

  test("HWF_ shell reference counts as used input", async () => {
    const wf = await parseWorkflowText(
      "e",
      `version: v1alpha1\ninputs:\n  name: text\nsteps:\n  - run: 'echo "$HWF_name"'\n`,
    );
    expect(wf.inputs).toHaveLength(1);
  });

  test("HWF_ env exact match still required", async () => {
    await expect(
      parseWorkflowText(
        "prefix",
        `version: v1alpha1\ninputs:\n  foo: text\nsteps:\n  - run: 'echo "$HWF_foobar"'\n`,
      ),
    ).rejects.toThrow(/unused input/);

    const wf = await parseWorkflowText(
      "exact",
      `version: v1alpha1\ninputs:\n  foo: text\nsteps:\n  - run: 'echo "$HWF_foo"'\n`,
    );
    expect(wf.inputs).toHaveLength(1);
  });
});
