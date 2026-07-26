import { HerdrError } from "../adapter/rpc";
import type { Placement } from "../workflow/types";
import type { StepRunOptions } from "./types";

export async function placeCommand(
  opts: StepRunOptions,
  place: Placement,
  argv: string[],
  label: string,
  cwd: string,
  env: Record<string, string> | undefined,
  ratio: number | undefined,
): Promise<{ tabId: string; paneId: string; workspaceId: string }> {
  if (place === "tab") {
    return opts.deps.layoutApply({
      workspaceId: opts.ctx.workspaceId,
      tabLabel: label,
      root: {
        type: "pane",
        label,
        cwd,
        command: argv,
        env: env ?? {},
      },
      focus: true,
    });
  }
  if (place === "right" || place === "down") {
    if (!opts.ctx.paneId || !opts.ctx.tabId) {
      throw new HerdrError("placement_failed", `in: ${place} requires an invoking pane`);
    }
    return opts.deps.layoutApply({
      tabId: opts.ctx.tabId,
      root: {
        type: "split",
        direction: place,
        ratio: ratio ?? 0.5,
        first: { type: "pane", pane_id: opts.ctx.paneId },
        second: {
          type: "pane",
          label,
          cwd,
          command: argv,
          env: env ?? {},
        },
      },
      focus: true,
    });
  }
  throw new HerdrError("placement_failed", "in: here does not place a pane");
}
