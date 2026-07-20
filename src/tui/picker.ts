import { basename } from "node:path";
import {
  Box,
  createCliRenderer,
  Input,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  Text,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { AgentsConfig, SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { WorkflowListEntry } from "../workflows";
import {
  acceptWorkflow,
  handlePickerKey,
  stdinLeakHandlers,
  submitInputChoice,
  submitInputText,
  submitPrompt,
} from "./picker-actions";
import { applyFilter, LIST_HINT, setListMode, type PickerState } from "./picker-modes";
import type { PickerRowValue } from "./picker-rows";
import { SelectList } from "./select-list";
import { resolveHostTheme } from "./theme";

export type PickerSessionOpts = {
  entries: WorkflowListEntry[];
  repoRoot: string;
  agents: AgentsConfig;
  sessions: SessionsConfig;
  ctx: InvocationContext;
};

export async function runPickerSession(opts: PickerSessionOpts): Promise<number> {
  const leak = stdinLeakHandlers();
  leak.drain();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    prependInputHandlers: leak.prepend,
  });
  const theme = await resolveHostTheme(renderer);

  renderer.root.add(
    Box(
      {
        flexDirection: "column",
        paddingX: 1,
        paddingY: 0,
        width: "100%",
        height: "100%",
        gap: 0,
      },
      Text({ content: `Launch · ${basename(opts.repoRoot)}`, ...theme.text }),
      Input({ id: "filter", width: "100%", placeholder: "filter…", ...theme.input }),
      SelectList("list", { theme: theme.select, showDescription: false, flexGrow: 1 }),
      Text({
        id: "status",
        content: "",
        visible: false,
        flexGrow: 1,
        ...theme.text,
      }),
      Text({ id: "invalid", content: "", attributes: TextAttributes.DIM, ...theme.text }),
      Input({
        id: "prompt-input",
        visible: false,
        width: "100%",
        placeholder: "prompt…",
        ...theme.input,
      }),
      Text({ id: "footer", content: LIST_HINT, attributes: TextAttributes.DIM, ...theme.text }),
    ),
  );

  const state: PickerState = {
    mode: "list",
    entries: opts.entries,
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    running: false,
    progressLines: [],
    repoRoot: opts.repoRoot,
    agents: opts.agents,
    sessions: opts.sessions,
    ctx: opts.ctx,
    renderer,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    status: renderer.root.findDescendantById("status") as TextRenderable,
    invalid: renderer.root.findDescendantById("invalid") as TextRenderable,
    promptInput: renderer.root.findDescendantById("prompt-input") as InputRenderable,
    footer: renderer.root.findDescendantById("footer") as TextRenderable,
  };

  state.list.on(SelectRenderableEvents.ITEM_SELECTED, (_i, option) => {
    if (state.mode === "input") {
      if (typeof option.value === "string") submitInputChoice(state, option.value);
      return;
    }
    if (state.mode !== "list") return;
    const value = option.value as PickerRowValue | undefined;
    if (!value) return;
    acceptWorkflow(state, value.entry);
  });
  state.filter.on(InputRenderableEvents.INPUT, () => {
    if (state.mode === "list") applyFilter(state);
  });
  state.promptInput.on(InputRenderableEvents.ENTER, (value) =>
    state.mode === "input" ? submitInputText(state, value) : submitPrompt(state, value),
  );
  renderer.keyInput.on("keypress", (key) => handlePickerKey(state, key));

  setListMode(state);

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });

  return state.exit?.code ?? 0;
}
