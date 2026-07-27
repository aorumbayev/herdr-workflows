import { loadWorkflow, resolveDynamicChoices } from "../../workflow/load";
import { substituteText, substituteValue } from "../../workflow/parse";
import type {
  InputSpec,
  LoadedWorkflow,
  ReturnsSpec,
  StepAction,
  TemplateNamespace,
} from "../../workflow/types";
import { errorText, type RunSteps, type StepCtx, type StepOutcome } from "../context";

type WorkflowActionSpec = Extract<StepAction, { kind: "workflow" }>;

let childRunSteps: RunSteps | undefined;

export function bindIncludeRunSteps(fn: RunSteps): void {
  childRunSteps = fn;
}

type ResolvedInputs = { ok: true; values: Record<string, string> } | { ok: false; error: string };

async function optionsFor(
  child: LoadedWorkflow,
  spec: InputSpec,
  repoRoot: string,
): Promise<string[] | undefined> {
  if (spec.options) return spec.options;
  if (!spec.dynamicOptions) return undefined;
  return resolveDynamicChoices(child.file, spec.name, spec.dynamicOptions, repoRoot);
}

async function resolveChildInputs(
  child: LoadedWorkflow,
  passed: Record<string, string>,
  repoRoot: string,
): Promise<ResolvedInputs> {
  const declared = new Set(child.inputs.map((spec) => spec.name));
  for (const name of Object.keys(passed)) {
    if (!declared.has(name)) {
      return { ok: false, error: `workflow '${child.name}' does not declare input '${name}'` };
    }
  }
  const values: Record<string, string> = {};
  for (const spec of child.inputs) {
    const value = Object.hasOwn(passed, spec.name) ? passed[spec.name] : spec.default;
    if (value === undefined) {
      return { ok: false, error: `workflow '${child.name}' requires input '${spec.name}'` };
    }
    const options = await optionsFor(child, spec, repoRoot);
    if (options && !options.includes(value)) {
      return {
        ok: false,
        error: `workflow '${child.name}' input '${spec.name}' must be one of: ${options.join(", ")}`,
      };
    }
    values[spec.name] = value;
  }
  return { ok: true, values };
}

function evaluateReturns(returns: ReturnsSpec, ns: TemplateNamespace): unknown {
  if (returns.kind === "template") return substituteValue(returns.template, ns);
  return Object.fromEntries(
    Object.entries(returns.fields).map(([name, template]) => [name, substituteValue(template, ns)]),
  );
}

export async function workflowStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "workflow") return { ok: false, error: "internal: not a workflow step" };
  if (!childRunSteps) return { ok: false, error: "internal: child runner is not bound" };
  return runChild(c, action, childRunSteps);
}

async function runChild(
  c: StepCtx,
  action: WorkflowActionSpec,
  runSteps: RunSteps,
): Promise<StepOutcome> {
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
    inputs = await resolveChildInputs(child, passed, repoRoot);
  } catch (error) {
    return { ok: false, error: errorText(error), details: { workflow: action.name } };
  }
  if (!inputs.ok) return { ok: false, error: inputs.error, details: { workflow: action.name } };

  const childValues: TemplateNamespace = {
    inputs: inputs.values,
    steps: {},
    context: c.values.context,
  };
  const result = await runSteps(
    child.steps,
    {
      ...c.opts,
      name: child.name,
      isEntry: false,
      workflowPath: [...c.opts.workflowPath, child.name],
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
