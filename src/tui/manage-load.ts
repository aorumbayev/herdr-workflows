import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CliRenderer,
  InputRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextRenderable,
} from "@opentui/core";
import { globalConfigPath, loadConfig, repoConfigPath } from "../config";
import { detectAgents, formatAgentsYaml } from "../init";
import { listWorkflows, type WorkflowListEntry } from "../workflows";
import { readRunLog, recentRuns, type RunLogEntry } from "../runlog";
import {
  buildConfigOptions,
  buildWorkflowOptions,
  buildRunOptions,
  formatRunPreview,
  MANAGE_TABS,
  previewLines,
  type ManageRowValue,
  type ManageTab,
} from "./manage-rows";

export type ManageState = {
  mode: "browse" | "confirm" | "name";
  tab: ManageTab;
  pendingDelete?: Extract<ManageRowValue, { kind: "workflow" }>;
  newScope: "repo" | "global";
  repoRoot: string;
  workflows: WorkflowListEntry[];
  runEntries: RunLogEntry[];
  renderer: CliRenderer;
  tabs: TabSelectRenderable;
  filter: InputRenderable;
  list: SelectRenderable;
  preview: TextRenderable;
  nameInput: InputRenderable;
  footer: TextRenderable;
};

export function manageHint(tab: ManageTab): string {
  if (tab === "workflows") return "filter · tab/[ ] tabs · enter edit · ^n new · ^x del · esc quit";
  if (tab === "config") return "tab/[ ] tabs · enter edit · q/esc quit";
  return "filter · tab/[ ] tabs · esc quit";
}

export async function editInEditor(renderer: CliRenderer, file: string): Promise<void> {
  renderer.suspend();
  try {
    const proc = Bun.spawn([process.env.EDITOR || "vi", file], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
  } finally {
    renderer.resume();
  }
}

async function ensureConfig(
  scope: "repo" | "global",
  repoRoot: string,
  file: string,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  if (scope === "repo") {
    await mkdir(join(repoRoot, ".hwf", "workflows"), { recursive: true });
    await Bun.write(file, formatAgentsYaml(await detectAgents()));
  } else {
    await Bun.write(file, formatAgentsYaml({}));
  }
}

function applyListOptions(state: ManageState): void {
  const filter = state.filter.value;
  if (state.tab === "workflows") {
    state.list.options = buildWorkflowOptions(state.workflows, filter);
  } else if (state.tab === "runs") {
    state.list.options = buildRunOptions(recentRuns(state.runEntries), filter);
  } else {
    return;
  }
  if (state.list.options.length > 0) {
    state.list.setSelectedIndex(
      Math.min(state.list.getSelectedIndex(), state.list.options.length - 1),
    );
  }
}

export async function updatePreview(state: ManageState): Promise<void> {
  const value = state.list.getSelectedOption()?.value as ManageRowValue | undefined;
  if (!value) {
    state.preview.content = state.list.options.length === 0 ? "(empty)" : "";
    return;
  }
  if (value.kind === "run") {
    state.preview.content = formatRunPreview(state.runEntries, value.run, value);
    return;
  }
  if (value.kind === "config" && value.missing) {
    state.preview.content = "(missing — enter to create)";
    return;
  }
  try {
    state.preview.content = previewLines(await Bun.file(value.file).text());
  } catch {
    state.preview.content = "(unreadable)";
  }
}

export async function reloadManage(state: ManageState): Promise<void> {
  let agentNames: string[] = [];
  try {
    agentNames = Object.keys((await loadConfig(state.repoRoot)).agents);
  } catch {
    agentNames = [];
  }
  state.workflows = await listWorkflows(state.repoRoot, agentNames);
  state.runEntries = await readRunLog();
  const repoExists = await Bun.file(repoConfigPath(state.repoRoot)).exists();
  const globalExists = await Bun.file(globalConfigPath()).exists();
  const idx = state.list.getSelectedIndex();

  if (state.tab === "workflows") {
    state.list.options = buildWorkflowOptions(state.workflows, state.filter.value);
  } else if (state.tab === "config") {
    state.list.options = buildConfigOptions(repoExists, globalExists, state.repoRoot);
  } else {
    state.list.options = buildRunOptions(recentRuns(state.runEntries), state.filter.value);
  }

  if (state.list.options.length > 0) {
    state.list.setSelectedIndex(Math.min(Math.max(idx, 0), state.list.options.length - 1));
  }
  await updatePreview(state);
}

export function setTab(state: ManageState, tab: ManageTab): void {
  state.tab = tab;
  const i = MANAGE_TABS.findIndex((t) => t.value === tab);
  if (i >= 0) state.tabs.setSelectedIndex(i);
  state.filter.visible = tab !== "config";
  if (tab === "config") state.filter.value = "";
  state.footer.content = manageHint(tab);
  void reloadManage(state).then(() => {
    if (state.mode !== "browse") return;
    if (tab === "config") state.list.focus();
    else state.filter.focus();
  });
}

export function onFilterInput(state: ManageState): void {
  if (state.mode !== "browse") return;
  if (state.tab === "config") return;
  applyListOptions(state);
  void updatePreview(state);
}

export async function ensureAndEdit(state: ManageState, value: ManageRowValue): Promise<void> {
  if (value.kind === "run") return;
  if (value.kind === "config" && value.missing) {
    await ensureConfig(value.scope, state.repoRoot, value.file);
  }
  await editInEditor(state.renderer, value.file);
  await reloadManage(state);
}
