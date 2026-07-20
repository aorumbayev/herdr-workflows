import { createCliRenderer } from "@opentui/core";
import type { AgentsConfig, SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { WorkflowListEntry } from "../workflows";
import { stdinLeakHandlers } from "./picker-actions";
import { bindPickerEvents, mountPickerUi } from "./picker-bind";
import { setListMode, type PickerState } from "./picker-modes";
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
  const ui = mountPickerUi(renderer, theme, opts.repoRoot);

  const state: PickerState = {
    mode: "list",
    entries: opts.entries,
    inputQueue: [],
    inputIndex: 0,
    inputValues: {},
    choiceOptions: [],
    running: false,
    progressLines: [],
    repoRoot: opts.repoRoot,
    agents: opts.agents,
    sessions: opts.sessions,
    ctx: opts.ctx,
    ...ui,
  };

  bindPickerEvents(state);
  setListMode(state);

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });

  return state.exit?.code ?? 0;
}
