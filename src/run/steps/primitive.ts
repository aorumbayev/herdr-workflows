import { HERDR_METHOD_BY_NAME } from "../../herdr-methods.generated";
import type { FlatStep, PlaceholderValues } from "../../workflow/types";
import { substituteParams } from "../../workflow/parse";
import { mapOut } from "./shell";

function autofill(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: { paneId?: string; tabId?: string; workspaceId?: string },
): Record<string, unknown> {
  const out = { ...params };
  const props = HERDR_METHOD_BY_NAME.get(method)?.params.properties ?? {};
  if (out.pane_id === undefined && ctx.paneId && props.pane_id) out.pane_id = ctx.paneId;
  if (out.tab_id === undefined && ctx.tabId && props.tab_id) out.tab_id = ctx.tabId;
  // herdr rejects layout.apply with both tab_id and workspace_id set; "" is not a pin.
  const pinsTab = method === "layout.apply" && out.tab_id !== undefined && out.tab_id !== "";
  if (out.workspace_id === undefined && ctx.workspaceId && props.workspace_id && !pinsTab) {
    out.workspace_id = ctx.workspaceId;
  }
  return out;
}

export async function primitiveStep(c: {
  step: FlatStep;
  values: PlaceholderValues;
  opts: {
    ctx: { paneId?: string; tabId?: string; workspaceId?: string };
    deps: {
      herdrCall: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      sleep?: (ms: number) => Promise<unknown>;
    };
  };
}): Promise<
  | { ok: true; bindings?: Record<string, string>; failures?: string[] }
  | { ok: false; error: string; failures?: string[] }
> {
  const step = c.step as FlatStep & { action: { kind: "primitive" } };
  const params = autofill(
    step.action.method,
    substituteParams(step.action.params, c.values),
    c.opts.ctx,
  );
  let result = (await c.opts.deps.herdrCall(step.action.method, params)) as Record<string, unknown>;
  // herdr answers notification.show with exit 0 even when nothing was displayed. "busy" means
  // another toast holds the screen — it clears on its own, so wait it out before failing.
  if (step.action.method === "notification.show") {
    for (let a = 0; a < 3 && result.shown === false && result.reason === "busy"; a++) {
      await (c.opts.deps.sleep ?? ((ms: number) => Bun.sleep(ms)))(2000);
      result = (await c.opts.deps.herdrCall(step.action.method, params)) as Record<string, unknown>;
    }
    if (result.shown === false) {
      const reason = typeof result.reason === "string" ? result.reason : "unknown";
      return { ok: false, error: `notification not shown: ${reason}` };
    }
  }
  return mapOut(step.out, result);
}
