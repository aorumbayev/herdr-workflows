import { homedir } from "node:os";
import { basename } from "node:path";
import {
  Box,
  createCliRenderer,
  Input,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelect,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  Text,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { resolveRepoRoot } from "../repo";
import {
  createWorkflow,
  ensureAndEdit,
  handleManageKey,
  manageHint,
  onFilterInput,
  reloadManage,
  setTab,
  updatePreview,
  type ManageState,
} from "./manage-actions";
import { MANAGE_TABS, type ManageRowValue, type ManageTab } from "./manage-rows";
import { SelectList } from "./select-list";
import { resolveHostTheme } from "./theme";

function shortRepo(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return basename(path);
}

export async function runManage(): Promise<void> {
  const repoRoot = await resolveRepoRoot();
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const theme = await resolveHostTheme(renderer);

  renderer.root.add(
    Box(
      { flexDirection: "column", padding: 1, width: "100%", height: "100%", gap: 1 },
      Text({ content: `herdr-workflows · ${shortRepo(repoRoot)}`, ...theme.text }),
      TabSelect({
        id: "tabs",
        width: "100%",
        // OpenTUI renders name in tabWidth-2; keep room for longest label.
        tabWidth: Math.max(...MANAGE_TABS.map((t) => t.name.length)) + 2,
        showDescription: false,
        showUnderline: true,
        wrapSelection: true,
        options: MANAGE_TABS.map((t) => ({ name: t.name, description: "", value: t.value })),
        ...theme.tab,
      }),
      Input({ id: "filter", width: "100%", placeholder: "filter…", ...theme.input }),
      SelectList("list", { theme: theme.select }),
      Text({ id: "preview", content: "", attributes: TextAttributes.DIM, ...theme.text }),
      Input({
        id: "name-input",
        visible: false,
        width: 40,
        placeholder: "workflow-name",
        ...theme.input,
      }),
      Text({ id: "footer", content: manageHint("workflows"), ...theme.text }),
    ),
  );

  const state: ManageState = {
    mode: "browse",
    tab: "workflows",
    newScope: "repo",
    repoRoot,
    workflows: [],
    runEntries: [],
    renderer,
    tabs: renderer.root.findDescendantById("tabs") as TabSelectRenderable,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    preview: renderer.root.findDescendantById("preview") as TextRenderable,
    nameInput: renderer.root.findDescendantById("name-input") as InputRenderable,
    footer: renderer.root.findDescendantById("footer") as TextRenderable,
  };

  state.tabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (_i, option) => {
    const tab = (option.value as ManageTab | undefined) ?? "workflows";
    if (tab === state.tab) return;
    setTab(state, tab);
  });
  state.list.on(SelectRenderableEvents.ITEM_SELECTED, (_i, option) => {
    if (state.mode !== "browse") return;
    void ensureAndEdit(state, option.value as ManageRowValue);
  });
  state.list.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (state.mode !== "browse") return;
    void updatePreview(state);
  });
  state.filter.on(InputRenderableEvents.INPUT, () => onFilterInput(state));
  state.nameInput.on(InputRenderableEvents.ENTER, (value) => {
    void createWorkflow(state, value);
  });
  renderer.keyInput.on("keypress", (key) => handleManageKey(state, key));

  state.filter.focus();
  await reloadManage(state);
  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });
}
