import { HERDR_METHOD_BY_NAME } from "../herdr-methods.generated";
import { isSensitiveContextPath, parseRaw, workflowTemplateRefs, type RawWorkflow } from "./parse";
import type { RecoveryAction, ReturnsSpec, WorkflowStep } from "./types";

/** Allowed methods that still deserve a visible authoring warning. */
const SENSITIVE_ALLOWED = new Set([
  "pane.close",
  "tab.close",
  "workspace.close",
  "agent.send_keys",
  "pane.send_keys",
  "pane.send_text",
  "pane.send_input",
  "worktree.create",
  "layout.apply",
]);

export type WorkflowSensitivity = {
  hasCommands: boolean;
  hasTranscript: boolean;
  sensitiveMethods: string[];
};

export function humanizeWorkflowName(name: string): string {
  const spaced = name.replace(/[-_]+/g, " ").trim();
  if (!spaced) return name;
  return spaced.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function workflowDisplayTitle(name: string, title?: string): string {
  return title?.trim() || humanizeWorkflowName(name);
}

function isSensitiveHerdrMethod(method: string): boolean {
  const entry = HERDR_METHOD_BY_NAME.get(method);
  if (entry && !entry.allowed) return true;
  return SENSITIVE_ALLOWED.has(method);
}

function collectHerdrMethods(steps: WorkflowStep[], onFailure?: RecoveryAction): string[] {
  const methods: string[] = [];
  const visit = (action: WorkflowStep["action"] | RecoveryAction) => {
    if (action.kind === "herdr") methods.push(action.method);
  };
  for (const step of steps) visit(step.action);
  if (onFailure) visit(onFailure);
  return methods;
}

export function analyzeWorkflowSensitivity(
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
): WorkflowSensitivity {
  const hasCommands = steps.some((s) => s.action.kind === "run") || onFailure?.kind === "run";
  const hasTranscript = workflowTemplateRefs(steps, returns, onFailure).some(
    isSensitiveContextPath,
  );
  const sensitiveMethods = [
    ...new Set(collectHerdrMethods(steps, onFailure).filter(isSensitiveHerdrMethod)),
  ].sort();
  return { hasCommands, hasTranscript, sensitiveMethods };
}

export function analyzeRawWorkflow(raw: RawWorkflow): WorkflowSensitivity {
  return analyzeWorkflowSensitivity(raw.steps, raw.returns, raw.onFailure);
}

export function analyzeYamlBody(file: string, body: string): WorkflowSensitivity {
  return analyzeRawWorkflow(parseRaw(file, body));
}

export function sensitivityLabels(flags: WorkflowSensitivity): string[] {
  const labels: string[] = [];
  if (flags.hasCommands) labels.push("commands");
  if (flags.hasTranscript) labels.push("transcript");
  for (const method of flags.sensitiveMethods) labels.push(`herdr:${method}`);
  return labels;
}

export function formatSensitivityBanner(flags: WorkflowSensitivity): string {
  const labels = sensitivityLabels(flags);
  if (labels.length === 0) return "";
  return `⚠ sensitive: ${labels.join(" · ")}\n`;
}
