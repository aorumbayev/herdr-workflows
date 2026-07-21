import { basename } from "node:path";
import {
  Box,
  Input,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  Text,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import { handlePickerKey } from "./picker-actions";
import { acceptWorkflow, submitInputChoice, submitInputText, submitPrompt } from "./picker-run";
import { applyChoiceFilter, applyFilter, LIST_HINT, type PickerState } from "./picker-modes";
import type { PickerRowValue } from "./picker-rows";
import { SelectList } from "./select-list";
import type { HostTheme } from "./theme";

export function mountPickerUi(
  renderer: CliRenderer,
  theme: HostTheme,
  repoRoot: string,
): Omit<
  PickerState,
  | "mode"
  | "entries"
  | "pending"
  | "inputQueue"
  | "inputIndex"
  | "inputValues"
  | "choiceOptions"
  | "exit"
  | "running"
  | "progressLines"
  | "repoRoot"
  | "agents"
  | "sessions"
  | "ctx"
  | "workflow"
  | "loadWorkflow"
> {
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
      Text({ content: `Launch · ${basename(repoRoot)}`, ...theme.text }),
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
  return {
    renderer,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    status: renderer.root.findDescendantById("status") as TextRenderable,
    invalid: renderer.root.findDescendantById("invalid") as TextRenderable,
    promptInput: renderer.root.findDescendantById("prompt-input") as InputRenderable,
    footer: renderer.root.findDescendantById("footer") as TextRenderable,
  };
}

export function bindPickerEvents(state: PickerState): void {
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
    else if (state.mode === "input" && state.choiceOptions.length > 0) applyChoiceFilter(state);
  });
  state.promptInput.on(InputRenderableEvents.ENTER, (value) =>
    state.mode === "input" ? submitInputText(state, value) : submitPrompt(state, value),
  );
  state.renderer.keyInput.on("keypress", (key) => handlePickerKey(state, key));
}
