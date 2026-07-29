import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateWhen } from "../src/workflow/conditions";
import { collectInputValues } from "../src/workflow/inputs";
import { parseWorkflowText } from "../src/workflow/load";
import { parseRaw as parseDoc } from "../src/workflow/parse";
import { buildLaunchPayload, parseLaunchPayload } from "../src/tui/run-launch";
import { runArgvStep } from "../src/run/steps/shell";

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-adaptive-"));
  await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
  return root;
}

describe("adaptive authoring grammar", () => {
  test("condition lists parse and reject structured when", () => {
    const doc = parseDoc(
      "f.yaml",
      `version: v1alpha1
steps:
  - run: "true"
    when:
      - '{{inputs.mode}} == "create"'
      - "{{inputs.ok}}"
`,
    );
    expect(doc.steps[0]!.when).toHaveLength(2);
    expect(() =>
      parseDoc(
        "f.yaml",
        `version: v1alpha1\nsteps:\n  - run: "true"\n    when:\n      - { path: x }\n`,
      ),
    ).toThrow(/when/);
  });

  test("mapped input when allow_custom min_length and success_codes", () => {
    const doc = parseDoc(
      "f.yaml",
      `version: v1alpha1
inputs:
  mode:
    type: choice
    options: [create, delete]
  branch:
    type: choice
    options: [main]
    allow_custom: true
    min_length: 1
    when: '{{inputs.mode}} == "create"'
steps:
  - run: [echo, hi]
    success_codes: [0, 1]
`,
    );
    expect(doc.inputs?.branch).toMatchObject({
      allow_custom: true,
      min_length: 1,
    });
    expect(doc.steps[0]!.action).toMatchObject({ kind: "run", successCodes: [0, 1] });
  });

  test("positioned rejection of invalid combinations", () => {
    expect(() =>
      parseDoc(
        "f.yaml",
        `version: v1alpha1\ninputs:\n  note:\n    type: text\n    allow_custom: true\nsteps:\n  - run: [echo, "{{inputs.note}}"]\n`,
      ),
    ).toThrow(/allow_custom/);
    expect(() =>
      parseDoc(
        "f.yaml",
        `version: v1alpha1\nsteps:\n  - run: [echo, hi]\n    success_codes: [0]\n    background: true\n    pane: { open: tab }\n`,
      ),
    ).toThrow(/success_codes/);
    expect(() =>
      parseDoc(
        "f.yaml",
        `version: v1alpha1\nsteps:\n  - run: [echo, hi]\n    success_codes: [0, 0]\n`,
      ),
    ).toThrow(/duplicate/);
  });

  test("pane.open whole-value template parses", () => {
    const doc = parseDoc(
      "f.yaml",
      `version: v1alpha1
inputs:
  place: [tab, beside, below]
steps:
  - run: [echo, hi]
    pane:
      open: "{{inputs.place}}"
    ready_when: /ready/
    timeout: 1s
`,
    );
    expect(doc.steps[0]!.action).toMatchObject({
      kind: "run",
      pane: { open: "{{inputs.place}}" },
    });
  });
});

describe("guard containment", () => {
  test("accepts matching guards and rejects weaker or out-of-order", async () => {
    await expect(
      parseWorkflowText(
        "ok",
        `version: v1alpha1
inputs:
  mode: [create, delete]
steps:
  - id: probe
    run: [echo, hi]
    when: '{{inputs.mode}} == "create"'
  - run: [echo, "{{steps.probe.stdout}}"]
    when: '{{inputs.mode}} == "create"'
`,
      ),
    ).resolves.toBeTruthy();

    await expect(
      parseWorkflowText(
        "weak",
        `version: v1alpha1
inputs:
  mode: [create, delete]
steps:
  - id: probe
    run: [echo, hi]
    when: '{{inputs.mode}} == "create"'
  - run: [echo, "{{steps.probe.stdout}}"]
`,
      ),
    ).rejects.toThrow(
      /not proven available.*missing producer when: \{\{inputs\.mode\}\} == "create".*consumer must include: \{\{inputs\.mode\}\} == "create"/,
    );

    await expect(
      parseWorkflowText(
        "order",
        `version: v1alpha1
inputs:
  mode: [create, delete]
steps:
  - id: probe
    run: [echo, hi]
    when: '{{inputs.mode}} == "create"'
  - run: [echo, hi]
    when:
      - "{{steps.probe.stdout}}"
      - '{{inputs.mode}} == "create"'
`,
      ),
    ).rejects.toThrow(/not proven available/);
  });

  test("conditional inputs need matching consumer guards", async () => {
    await expect(
      parseWorkflowText(
        "in",
        `version: v1alpha1
inputs:
  mode: [create, delete]
  branch:
    type: choice
    options: [main]
    when: '{{inputs.mode}} == "create"'
steps:
  - run: [echo, "{{inputs.branch}}"]
    when: '{{inputs.mode}} == "create"'
`,
      ),
    ).resolves.toBeTruthy();

    await expect(
      parseWorkflowText(
        "bad",
        `version: v1alpha1
inputs:
  mode: [create, delete]
  branch:
    type: choice
    options: [main]
    when: '{{inputs.mode}} == "create"'
steps:
  - run: [echo, "{{inputs.branch}}"]
`,
      ),
    ).rejects.toThrow(/not proven available/);

    await expect(
      parseWorkflowText(
        "fwd",
        `version: v1alpha1
inputs:
  branch:
    type: text
    when: '{{inputs.mode}} == "create"'
  mode: [create, delete]
steps:
  - run: [echo, "{{inputs.branch}}"]
    when: '{{inputs.mode}} == "create"'
`,
      ),
    ).rejects.toThrow(/forward reference/);
  });
});

describe("pane.open domain validation", () => {
  test("accepts closed placement choice and rejects unbounded sources", async () => {
    await expect(
      parseWorkflowText(
        "place",
        `version: v1alpha1
inputs:
  place: [tab, beside, below]
steps:
  - run: [echo, hi]
    pane: { open: "{{inputs.place}}" }
    ready_when: /ready/
    timeout: 1s
`,
      ),
    ).resolves.toBeTruthy();

    for (const body of [
      `version: v1alpha1\ninputs:\n  place: text\nsteps:\n  - run: [echo, hi]\n    pane: { open: "{{inputs.place}}" }\n    ready_when: /ready/\n    timeout: 1s\n`,
      `version: v1alpha1\ninputs:\n  place:\n    type: choice\n    options: [tab, beside]\n    allow_custom: true\nsteps:\n  - run: [echo, hi]\n    pane: { open: "{{inputs.place}}" }\n    ready_when: /ready/\n    timeout: 1s\n`,
      `version: v1alpha1\ninputs:\n  place:\n    type: choice\n    options: { run: [echo, tab] }\nsteps:\n  - run: [echo, hi]\n    pane: { open: "{{inputs.place}}" }\n    ready_when: /ready/\n    timeout: 1s\n`,
      `version: v1alpha1\ninputs:\n  mode: [a, b]\n  place:\n    type: choice\n    options: [tab, beside, below]\n    when: '{{inputs.mode}} == "a"'\nsteps:\n  - run: [echo, hi]\n    pane: { open: "{{inputs.place}}" }\n    ready_when: /ready/\n    timeout: 1s\n    when: '{{inputs.mode}} == "a"'\n`,
      `version: v1alpha1\nsteps:\n  - run: [echo, hi]\n    pane: { open: "{{context.platform}}" }\n    ready_when: /ready/\n    timeout: 1s\n`,
    ]) {
      await expect(parseWorkflowText("bad", body)).rejects.toThrow(/pane\.open/);
    }
  });
});

describe("sequential input collection", () => {
  test("skips inactive inputs and resolves active dynamic once", async () => {
    const root = await tempRepo();
    const script = join(root, "opts.sh");
    await writeFile(script, "#!/bin/sh\necho one\necho two\n");
    await Bun.spawn(["chmod", "+x", script]).exited;
    let runs = 0;
    const wrapped = join(root, "count.sh");
    await writeFile(wrapped, `#!/bin/sh\necho run >> ${join(root, "count.log")}\n${script}\n`);
    await Bun.spawn(["chmod", "+x", wrapped]).exited;

    const specs = (
      await parseWorkflowText(
        "dyn",
        `version: v1alpha1
inputs:
  mode: [create, delete]
  branch:
    type: choice
    options:
      run: [${JSON.stringify(wrapped)}]
    when: '{{inputs.mode}} == "create"'
  worktree:
    type: text
    when: '{{inputs.mode}} != "create"'
steps:
  - run: [echo, "{{inputs.branch}}"]
    when: '{{inputs.mode}} == "create"'
  - run: [echo, "{{inputs.worktree}}"]
    when: '{{inputs.mode}} != "create"'
`,
        undefined,
        root,
      )
    ).inputs;

    const create = await collectInputValues({
      specs,
      provided: { mode: "create", branch: "one" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "dyn.yaml",
      resolveDynamic: true,
    });
    expect(create.ok).toBe(true);
    if (create.ok) {
      expect(create.values).toEqual({ mode: "create", branch: "one" });
      expect(create.domains.branch).toEqual(["one", "two"]);
    }
    const log1 = await Bun.file(join(root, "count.log")).text();
    expect(log1.trim().split("\n")).toHaveLength(1);

    const del = await collectInputValues({
      specs,
      provided: { mode: "delete", worktree: "wt" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "dyn.yaml",
      resolveDynamic: true,
    });
    expect(del.ok).toBe(true);
    if (del.ok) expect(Object.keys(del.domains)).toHaveLength(0);
    const log2 = await Bun.file(join(root, "count.log")).text();
    expect(log2.trim().split("\n")).toHaveLength(1);

    const inactive = await collectInputValues({
      specs,
      provided: { mode: "delete", branch: "one" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "dyn.yaml",
      resolveDynamic: true,
    });
    expect(inactive.ok).toBe(false);

    const custom = await collectInputValues({
      specs: [
        {
          name: "branch",
          type: "choice",
          options: ["main"],
          allowCustom: true,
          minLength: 1,
        },
      ],
      provided: { branch: "feature/x" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "x.yaml",
    });
    expect(custom).toEqual({
      ok: true,
      values: { branch: "feature/x" },
      domains: {},
    });

    const short = await collectInputValues({
      specs: [{ name: "branch", type: "text", minLength: 1 }],
      provided: { branch: "" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "x.yaml",
    });
    expect(short.ok).toBe(false);
    void runs;
  });

  test("launch payload domains reuse snapshot and reject mismatches", async () => {
    const payload = buildLaunchPayload("w", { branch: "one" }, { branch: ["one", "two"] });
    expect(JSON.stringify(payload)).not.toContain("argv");
    const parsed = parseLaunchPayload(JSON.stringify(payload));
    expect(parsed.domains).toEqual({ branch: ["one", "two"] });

    const root = await tempRepo();
    const specs = [
      {
        name: "branch",
        type: "choice" as const,
        dynamicOptions: { run: ["echo", "fresh"] },
      },
    ];
    const reused = await collectInputValues({
      specs,
      provided: { branch: "one" },
      domains: { branch: ["one", "two"] },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "x.yaml",
      resolveDynamic: true,
    });
    expect(reused).toEqual({
      ok: true,
      values: { branch: "one" },
      domains: { branch: ["one", "two"] },
    });

    const bad = await collectInputValues({
      specs: [{ name: "note", type: "text" }],
      provided: { note: "x" },
      domains: { note: ["a"] },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "x.yaml",
    });
    expect(bad.ok).toBe(false);

    const missingSnap = await collectInputValues({
      specs,
      provided: { branch: "one" },
      config: { profiles: {}, transcripts: {} },
      repoRoot: root,
      file: "x.yaml",
      resolveDynamic: false,
    });
    expect(missingSnap.ok).toBe(false);
    if (!missingSnap.ok)
      expect(missingSnap.error).toMatch(/missing launch payload domain snapshot/);
  });

  test("inactive profile inputs do not resolve options during collection", async () => {
    const root = await tempRepo();
    const collected = await collectInputValues({
      specs: [
        { name: "mode", type: "choice", options: ["skip", "use"] },
        {
          name: "role",
          type: "profile",
          when: [{ kind: "eq", path: "inputs.mode", value: "use", negate: false }],
        },
      ],
      provided: { mode: "skip" },
      config: {
        profiles: { claude: { kind: "claude" } },
        transcripts: {},
      },
      repoRoot: root,
      file: "p.yaml",
    });
    expect(collected).toEqual({
      ok: true,
      values: { mode: "skip" },
      domains: {},
    });
  });
});

describe("runner adaptive semantics", () => {
  test("condition lists short-circuit AND", () => {
    const ns = {
      inputs: { mode: "delete", ok: "yes" },
      steps: {},
      context: {},
    };
    expect(
      evaluateWhen(
        [
          { kind: "eq", path: "inputs.mode", value: "create", negate: false },
          { kind: "truthy", path: "inputs.ok" },
        ],
        ns,
      ),
    ).toBe(false);
  });

  test("success_codes accepts listed exits", async () => {
    const ok = await runArgvStep(["sh", "-c", "exit 1"], {
      cwd: process.cwd(),
      successCodes: [0, 1],
    });
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(1);
    expect(ok.failed).toBe(false);

    const fail = await runArgvStep(["sh", "-c", "exit 2"], {
      cwd: process.cwd(),
      successCodes: [0, 1],
    });
    expect(fail.ok).toBe(false);
    expect(fail.failed).toBe(true);
  });
});

describe("workflow inspect", () => {
  test("prints metadata without executing discovery", async () => {
    const root = await tempRepo();
    const home = await mkdtemp(join(tmpdir(), "hwf-home-"));
    const plugin = await mkdtemp(join(tmpdir(), "hwf-plugin-"));
    const state = await mkdtemp(join(tmpdir(), "hwf-state-"));
    const marker = join(root, "ran");
    const script = join(root, "discover.sh");
    await writeFile(script, `#!/bin/sh\ntouch ${marker}\necho a\n`);
    await Bun.spawn(["chmod", "+x", script]).exited;
    await writeFile(
      join(root, ".hwf", "workflows", "inspect-me.yaml"),
      `version: v1alpha1
inputs:
  mode: [create, delete]
  branch:
    type: choice
    options:
      run: [${JSON.stringify(script)}]
    when: '{{inputs.mode}} == "create"'
steps:
  - run: [echo, "{{inputs.mode}}"]
  - run: [echo, "{{inputs.branch}}"]
    when: '{{inputs.mode}} == "create"'
`,
    );

    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "cli.ts"),
        "workflow",
        "inspect",
        "inspect-me",
      ],
      {
        cwd: root,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          HERDR_PLUGIN_CONFIG_DIR: plugin,
          HERDR_PLUGIN_STATE_DIR: state,
          HERDR_WORKFLOWS_REPO_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("options.run:");
    expect(stdout).toContain("branch:");
    expect(await Bun.file(marker).exists()).toBe(false);

    const resolveSkipped = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "cli.ts"),
        "workflow",
        "inspect",
        "inspect-me",
        "--input",
        "mode=delete",
        "--resolve",
      ],
      {
        cwd: root,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          HERDR_PLUGIN_CONFIG_DIR: plugin,
          HERDR_PLUGIN_STATE_DIR: state,
          HERDR_WORKFLOWS_REPO_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await resolveSkipped.exited).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
