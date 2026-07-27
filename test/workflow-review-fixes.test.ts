import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflows, loadWorkflowEntry } from "../src/workflow/load";
import type { PickerState } from "../src/tui/picker";
import { acceptWorkflow, startRun } from "../src/tui/picker";

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
    agents: {},
    sessions: {},
    ctx: { selection: "", cwd: "/repo" },
    loadWorkflow: async () => {
      throw new Error("reload failed");
    },
    renderer: { destroy: () => undefined },
    filter: { visible: true },
    list: { visible: true, flexGrow: 1 },
    status: { visible: false, flexGrow: 0, content: "" },
    invalid: { visible: true },
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

    const entries = await listWorkflows(root);
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
    );
    expect(workflow.file).toBe(globalFile);
    expect(workflow.repoOwned).toBe(false);
  });

  test("picker renders loader errors as terminal failures", async () => {
    const state = pickerState();
    await startRun(state, { name: "broken", source: "global", file: "/global/broken.yaml" }, "");

    expect(state.running).toBe(false);
    expect(String(state.status.content)).toContain("Failed · reload failed");
    expect(String(state.footer.content)).toBe("enter/esc close");
  });

  test("global entries with repo-owned composition require confirmation", () => {
    const state = pickerState();
    let loads = 0;
    state.loadWorkflow = async () => {
      loads += 1;
      throw new Error("must not load before confirmation");
    };

    acceptWorkflow(state, {
      name: "global-entry",
      source: "global",
      file: "/global/entry.yaml",
      repoOwned: true,
    });

    expect(state.mode).toBe("confirm");
    expect(loads).toBe(0);
  });
});
