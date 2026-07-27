import type { TemplateNamespace, WorkflowStep } from "../../workflow/types";

export async function agentStep(_c: {
  step: WorkflowStep;
  values: TemplateNamespace;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return { ok: false, error: "v1alpha1 agent execution is not implemented yet" };
}
