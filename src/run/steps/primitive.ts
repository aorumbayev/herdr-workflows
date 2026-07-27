import { assertFocusPolicy } from "../../herdr-policy";
import { validateMethodParams } from "../../herdr-methods";
import { substituteParams } from "../../workflow/parse";
import { dispatchFailure, type StepCtx, type StepOutcome } from "../context";

export { assertFocusPolicy } from "../../herdr-policy";

export async function herdrStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "herdr") return { ok: false, error: "internal: not a herdr step" };
  const params = substituteParams(action.params, c.values) ?? {};
  const policy = assertFocusPolicy(action.method, params);
  if (policy) return { ok: false, error: policy, details: { method: action.method } };
  const invalid = validateMethodParams(action.method, params);
  if (invalid) return { ok: false, error: invalid, details: { method: action.method } };
  try {
    const result = await c.opts.deps.herdrCall(action.method, params);
    return { ok: true, result };
  } catch (error) {
    const failure = dispatchFailure(`herdr ${action.method}`, error);
    return failure.ok ? failure : { ...failure, details: { method: action.method } };
  }
}
