import { homedir } from "node:os";
import { join } from "node:path";
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
  unresolvedChildren: string[];
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

function childWorkflowNames(steps: WorkflowStep[], onFailure?: RecoveryAction): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (step.action.kind === "workflow") names.push(step.action.name);
  }
  if (onFailure?.kind === "workflow") names.push(onFailure.name);
  return names;
}

function analyzeWorkflowSensitivity(
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
  return { hasCommands, hasTranscript, sensitiveMethods, unresolvedChildren: [] };
}

export function analyzeRawWorkflow(raw: RawWorkflow): WorkflowSensitivity {
  return analyzeWorkflowSensitivity(raw.steps, raw.returns, raw.onFailure);
}

/** `workflow:` names referenced by a single shared payload (never included in the payload itself). */
export function referencedWorkflowChildren(raw: RawWorkflow): string[] {
  return [...new Set(childWorkflowNames(raw.steps, raw.onFailure))].sort();
}

/** Same repo-over-global resolution the loader uses. */
async function resolveWorkflowFile(name: string, repoRoot: string): Promise<string | undefined> {
  const repo = join(repoRoot, ".hwf", "workflows", `${name}.yaml`);
  if (await Bun.file(repo).exists()) return repo;
  const global = join(process.env.HOME ?? homedir(), ".hwf", "workflows", `${name}.yaml`);
  if (await Bun.file(global).exists()) return global;
  return undefined;
}

export function mergeSensitivity(into: WorkflowSensitivity, from: WorkflowSensitivity): void {
  into.hasCommands ||= from.hasCommands;
  into.hasTranscript ||= from.hasTranscript;
  for (const method of from.sensitiveMethods) {
    if (!into.sensitiveMethods.includes(method)) into.sensitiveMethods.push(method);
  }
  for (const name of from.unresolvedChildren) {
    if (!into.unresolvedChildren.includes(name)) into.unresolvedChildren.push(name);
  }
}

/**
 * Aggregate sensitivity across resolvable `workflow:` children (and recovery), with cycle
 * safety. Unresolvable children are listed rather than treated as clean.
 */
export async function analyzeResolvedSensitivity(
  workflow: {
    name: string;
    steps: WorkflowStep[];
    returns?: ReturnsSpec;
    onFailure?: RecoveryAction;
  },
  repoRoot: string,
  stack: string[] = [],
): Promise<WorkflowSensitivity> {
  const local = analyzeWorkflowSensitivity(workflow.steps, workflow.returns, workflow.onFailure);
  if (stack.includes(workflow.name)) return local;

  const nextStack = [...stack, workflow.name];
  const aggregated: WorkflowSensitivity = {
    hasCommands: local.hasCommands,
    hasTranscript: local.hasTranscript,
    sensitiveMethods: [...local.sensitiveMethods],
    unresolvedChildren: [],
  };

  for (const childName of childWorkflowNames(workflow.steps, workflow.onFailure)) {
    if (nextStack.includes(childName)) continue;
    const file = await resolveWorkflowFile(childName, repoRoot);
    if (!file) {
      if (!aggregated.unresolvedChildren.includes(childName)) {
        aggregated.unresolvedChildren.push(childName);
      }
      continue;
    }
    try {
      const raw = parseRaw(file, await Bun.file(file).text());
      const child = await analyzeResolvedSensitivity(
        {
          name: childName,
          steps: raw.steps,
          returns: raw.returns,
          onFailure: raw.onFailure,
        },
        repoRoot,
        nextStack,
      );
      mergeSensitivity(aggregated, child);
    } catch {
      if (!aggregated.unresolvedChildren.includes(childName)) {
        aggregated.unresolvedChildren.push(childName);
      }
    }
  }

  aggregated.sensitiveMethods.sort();
  aggregated.unresolvedChildren.sort();
  return aggregated;
}

export async function analyzeYamlTree(
  file: string,
  body: string,
  name: string,
  repoRoot: string,
): Promise<WorkflowSensitivity> {
  const raw = parseRaw(file, body);
  return analyzeResolvedSensitivity(
    { name, steps: raw.steps, returns: raw.returns, onFailure: raw.onFailure },
    repoRoot,
  );
}

export function sensitivityLabels(flags: WorkflowSensitivity): string[] {
  const labels: string[] = [];
  if (flags.hasCommands) labels.push("commands");
  if (flags.hasTranscript) labels.push("transcript");
  for (const method of flags.sensitiveMethods) labels.push(`herdr:${method}`);
  for (const name of flags.unresolvedChildren) labels.push(`unresolved:${name}`);
  return labels;
}

export function formatSensitivityBanner(flags: WorkflowSensitivity, label = "sensitive"): string {
  const labels = sensitivityLabels(flags);
  if (labels.length === 0) return "";
  return `⚠ ${label}: ${labels.join(" · ")}\n`;
}
