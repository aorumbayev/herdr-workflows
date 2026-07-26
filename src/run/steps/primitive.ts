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
  if (out.workspace_id === undefined && ctx.workspaceId && props.workspace_id) {
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
  const result = (await c.opts.deps.herdrCall(step.action.method, params)) as Record<
    string,
    unknown
  >;
  return mapOut(step.out, result);
}
