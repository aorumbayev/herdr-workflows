import { assertHwfEnvValues } from "../../limits";
import { collectWorkflowInputs } from "../../workflow/inputs";
import { substituteText, substituteValue } from "../../workflow/template";
import type {
  LoadedWorkflow,
  ReturnsSpec,
  StepAction,
  TemplateNamespace,
} from "../../workflow/types";
import { loadWorkflow } from "../../workflow/load";
import { errorText, type StepCtx, type StepOutcome } from "../context";

type WorkflowActionSpec = Extract<StepAction, { kind: "workflow" }>;

type ResolvedInputs = { ok: true; values: Record<string, string> } | { ok: false; error: string };

export function evaluateReturns(returns: ReturnsSpec, ns: TemplateNamespace): unknown {
  if (returns.kind === "template") return substituteValue(returns.template, ns);
  return Object.fromEntries(
    Object.entries(returns.fields).map(([name, template]) => [name, substituteValue(template, ns)]),
  );
}

export async function workflowStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "workflow") return { ok: false, error: "internal: not a workflow step" };
  return runChild(c, action);
}

async function runChild(c: StepCtx, action: WorkflowActionSpec): Promise<StepOutcome> {
  const repoRoot = c.opts.repoRoot;
  let child: LoadedWorkflow;
  try {
    child = await loadWorkflow(action.name, repoRoot, c.opts.config);
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }
  const passed = Object.fromEntries(
    Object.entries(action.inputs ?? {}).map(([name, template]) => [
      name,
      substituteText(template, c.values),
    ]),
  );
  let inputs: ResolvedInputs;
  try {
    const collected = await collectWorkflowInputs(child, {
      provided: passed,
      config: c.opts.config,
      repoRoot,
      resolveDynamic: true,
    });
    inputs = collected.ok
      ? { ok: true, values: collected.values }
      : { ok: false, error: collected.error };
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }
  if (!inputs.ok) return { ok: false, error: inputs.error, details: { workflow: action.name } };

  try {
    assertHwfEnvValues("HWF environment", inputs.values);
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }

  const childValues: TemplateNamespace = {
    inputs: inputs.values,
    steps: {},
    context: c.values.context,
  };
  const childPath = [...c.opts.workflowPath, child.name];
  const result = await c.opts.runSteps(
    child.steps,
    {
      ...c.opts,
      name: child.name,
      isEntry: false,
      workflowPath: childPath,
      parentOrdinal: c.stepIndex,
      recorder: c.opts.recorder.child({
        name: child.name,
        workflowPath: childPath,
        parentOrdinal: c.stepIndex,
      }),
    },
    childValues,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      details: { workflow: child.name },
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.coordinationLost ? { coordinationLost: true } : {}),
    };
  }
  if (!child.returns) return { ok: true };
  return { ok: true, result: evaluateReturns(child.returns, childValues) };
}
