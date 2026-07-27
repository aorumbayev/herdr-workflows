import type { TemplateNamespace, WorkflowStep } from "../../workflow/types";

export async function workflowStep(_c: {
  step: WorkflowStep;
  values: TemplateNamespace;
}): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }> {
  return { ok: false, error: "v1alpha1 workflow composition is not implemented yet" };
}

export function bindIncludeRunSteps(_fn: unknown): void {}
