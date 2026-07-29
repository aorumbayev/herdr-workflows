import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflows, loadWorkflowEntry } from "../src/workflow/load";
import type { PickerState } from "../src/tui/picker";
import { acceptWorkflow, startRun } from "../src/tui/picker";
import { themeFromPalette } from "../src/tui/theme";
import type { LoadedWorkflow } from "../src/workflow/types";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-review-"));
  dirs.push(root);
  const workflows = join(root, ".hwf", "workflows");
  await mkdir(workflows, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(join(workflows, `${name}.yaml`), body)),
  );
  return root;
}

function pickerState(): PickerState {
  return {
    mode: "list",
    entries: [],
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    choiceOptions: [],
    running: false,
    progressLines: [],
    repoRoot: "/repo",
    config: { profiles: {}, transcripts: {} },
    ctx: { selection: "", cwd: "/repo" },
    loadWorkflow: async () => {
      throw new Error("reload failed");
    },
    contentWidth: 80,
    theme: themeFromPalette(null),
    renderer: { destroy: () => undefined },
    filterRow: { visible: true },
    filter: { visible: true },
    updateHint: { visible: false, content: "" },
    listBlock: { visible: true },
    list: {
      visible: true,
      flexGrow: 0,
      height: 6,
      options: [],
      getSelectedIndex: () => 0,
    },
    status: { visible: false, flexGrow: 0, content: "" },
    detail: { visible: false, content: "" },
    rule: { visible: false, content: "" },
    promptInput: { visible: false },
    footer: { content: "" },
  } as unknown as PickerState;
}

const V1 = "version: v1alpha1\n";

describe("review regressions", () => {
  test("listing marks dynamic choice inputs without executing them", async () => {
    const root = await repoWith({
      dynamic: `${V1}inputs:
  target:
    type: choice
    options:
      run: [printf, main]
steps:
  - run: [echo, "{{inputs.target}}"]
`,
    });

    const entries = await listWorkflows(root, { profiles: {}, transcripts: {} });
    expect(entries.find((e) => e.name === "dynamic")?.dynamicOptions).toBe(true);
  });

  test("exact global entry file is preserved during load", async () => {
    const root = await repoWith({
      entry: `${V1}steps:\n  - run: "true"\n`,
    });
    const globalFile = join(root, "global-entry.yaml");
    await writeFile(globalFile, `${V1}steps:\n  - run: "true"\n`);

    const workflow = await loadWorkflowEntry(
      { name: "entry", source: "global", file: globalFile },
      root,
      { profiles: {}, transcripts: {} },
    );
    expect(workflow.file).toBe(globalFile);
    expect(workflow.repoOwned).toBe(false);
  });

  test("picker renders loader errors as terminal failures", async () => {
    const state = pickerState();
    await startRun(state, { name: "broken", source: "global", file: "/global/broken.yaml" });

    expect(state.running).toBe(false);
    expect(String(state.status.content)).toContain("Failed | reload failed");
    expect(String(state.footer.content)).toBe("enter/esc close");
  });

  test("picker loads selected workflows without a second confirmation gate", async () => {
    const state = pickerState();
    let loads = 0;
    state.loadWorkflow = async (entry) => {
      loads += 1;
      const workflow: LoadedWorkflow = {
        name: entry.name,
        file: entry.file,
        version: "v1alpha1",
        hidden: false,
        steps: [{ action: { kind: "run", payload: { form: "argv", argv: ["true"] } } }],
        inputs: [],
        repoOwned: entry.source === "repo",
        needsTranscript: false,
      };
      return workflow;
    };

    acceptWorkflow(state, {
      name: "global-entry",
      source: "global",
      file: "/global/entry.yaml",
      repoOwned: false,
    });

    await Bun.sleep(0);
    expect(loads).toBe(1);
    expect(state.mode).not.toBe("list");
  });
});
