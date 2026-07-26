import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflows, loadWorkflow, loadWorkflowEntry } from "../src/workflow/load";
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

describe("review regressions", () => {
  test("listing dynamic options does not execute their command", async () => {
    const root = await repoWith({
      dynamic: `inputs:
  target: sh touch option-command-ran; printf main
steps:
  - run: [echo, "{target}"]
`,
    });

    await listWorkflows(root);
    expect(await Bun.file(join(root, "option-command-ran")).exists()).toBe(false);

    const workflow = await loadWorkflow("dynamic", root);
    expect(workflow.inputs[0]?.options).toEqual(["main"]);
    expect(await Bun.file(join(root, "option-command-ran")).exists()).toBe(true);
  });

  test("listing validates dynamic workflows without executing choices", async () => {
    const root = await repoWith({
      invalid: `inputs:
  unused: sh touch invalid-option-ran; printf value
steps:
  - run: "true"
`,
    });

    const entry = (await listWorkflows(root)).find((candidate) => candidate.name === "invalid");
    expect(entry?.error).toContain("declared but never referenced");
    expect(await Bun.file(join(root, "invalid-option-ran")).exists()).toBe(false);
  });

  test("exact global entry cannot be replaced by repo shadow during load", async () => {
    const root = await repoWith({
      entry: `inputs:
  target: sh touch repo-shadow-ran; printf value
steps:
  - run: [echo, "{target}"]
`,
    });
    const globalFile = join(root, "global-entry.yaml");
    await writeFile(globalFile, 'steps:\n  - run: "true"\n');

    const workflow = await loadWorkflowEntry(
      { name: "entry", source: "global", file: globalFile },
      root,
    );
    expect(workflow.file).toBe(globalFile);
    expect(await Bun.file(join(root, "repo-shadow-ran")).exists()).toBe(false);
  });

  test("exact global entry records repo-owned composition", async () => {
    const root = await repoWith({ child: 'steps:\n  - run: "true"\n' });
    const globalFile = join(root, "global-entry.yaml");
    await writeFile(globalFile, "steps:\n  - use: child\n");

    const workflow = await loadWorkflowEntry(
      { name: "global-entry", source: "global", file: globalFile },
      root,
    );
    expect(workflow.repoOwned).toBe(true);
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
