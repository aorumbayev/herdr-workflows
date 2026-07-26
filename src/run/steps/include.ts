import type { FlatStep, PlaceholderValues } from "../../workflow/types";
import { substitute } from "../../workflow/parse";

type IncludeResult =
  | { ok: true; skipped?: boolean; failures?: string[] }
  | { ok: false; error: string; failures?: string[]; aborted?: boolean };

type IncludeOpts = {
  name: string;
  agents: Record<string, string[]>;
  ctx: { cwd: string; selection?: string };
  deps: unknown;
  runId: string;
  onProgress?: (
    step: number,
    total: number,
    label: string,
    outcome?: "ok" | "skip" | "fail",
  ) => void;
  onStderr?: (text: string) => void;
};

type RunStepsFn = (
  steps: FlatStep[],
  opts: IncludeOpts,
  values: PlaceholderValues,
) => Promise<IncludeResult>;

let runStepsRef: RunStepsFn | undefined;

export function bindIncludeRunSteps(fn: RunStepsFn): void {
  runStepsRef = fn;
}

export async function includeStep(c: {
  step: FlatStep;
  values: PlaceholderValues;
  opts: IncludeOpts;
}): Promise<
  | { ok: true; bindings?: Record<string, string>; failures?: string[] }
  | { ok: false; error: string; failures?: string[] }
> {
  const action = c.step.action;
  if (action.kind !== "include") {
    return { ok: false, error: "internal: not an include step" };
  }
  const runSteps = runStepsRef;
  if (!runSteps) return { ok: false, error: "internal: include runner not bound" };

  const childValues: PlaceholderValues = {
    pane: c.values.pane ?? "",
    selection: c.values.selection ?? "",
    prompt: c.values.prompt ?? "",
    session: c.values.session ?? "",
    session_file: c.values.session_file ?? "",
    source_tab: c.values.source_tab ?? "",
    agent: c.values.agent ?? "",
    error: c.values.error ?? "",
  };
  for (const [k, v] of Object.entries(action.defaults)) {
    childValues[k] = substitute(v, c.values);
  }
  for (const [k, v] of Object.entries(action.with)) {
    childValues[k] = substitute(v, c.values);
  }
  const result = await runSteps(action.steps, c.opts, childValues);
  if (!result.ok) {
    return { ok: false, error: result.error, failures: result.failures };
  }
  const bindings: Record<string, string> = {};
  for (const name of action.exportedOuts) {
    if (childValues[name] !== undefined) bindings[name] = childValues[name]!;
  }
  return { ok: true, bindings, failures: result.failures };
}
