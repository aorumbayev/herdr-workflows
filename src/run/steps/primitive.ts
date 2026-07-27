import type { TemplateNamespace, WorkflowStep } from "../../workflow/types";

export async function herdrStep(_c: {
  step: WorkflowStep;
  values: TemplateNamespace;
}): Promise<{ ok: true; result?: Record<string, unknown> } | { ok: false; error: string }> {
  return { ok: false, error: "v1alpha1 herdr execution is not implemented yet" };
}
