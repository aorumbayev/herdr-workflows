import { join } from "node:path";
import type { InvocationContext, TranscriptExtractor, WorkflowsConfig } from "../context";
import { HerdrError, validateHerdrInvocation } from "../host";
import { assertUnderCaptureCap, CAPTURE_BYTE_LIMIT, CaptureLimitError } from "../context";
import { substituteParams } from "../workflow/template";
import type { TemplateNamespace, WorkflowStep } from "../workflow/types";
import type { RunRecorder } from "../history";

export type StepFailure = {
  message: string;
  workflow: string;
  action: "agent" | "run" | "herdr" | "workflow";
  step_number: number;
  workflow_path: string[];
  step_id?: string;
  details: Record<string, unknown>;
};

export type StepOutcome =
  | { ok: true; result?: unknown; skipped?: boolean; launched?: boolean; blocked?: boolean }
  | {
      ok: false;
      error: string;
      details?: Record<string, unknown>;
      coordinationLost?: boolean;
      hardFailure?: boolean;
      failure?: StepFailure;
      blocked?: boolean;
    };

export type RunnerDeps = {
  herdrCall: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notificationShow: (title: string, body?: string) => Promise<void>;
  agentStatus: (target: string) => Promise<string>;
  agentInfo: (target: string) => Promise<Record<string, unknown>>;
  paneClose: (paneId: string) => Promise<void>;
  tabClose: (tabId: string) => Promise<void>;
  reportToken: (paneId: string, value: string | null) => Promise<void>;
  transcriptText: (
    paneId: string,
    transcripts: Record<string, TranscriptExtractor>,
    opts: { invocationCwd: string; projectsBase?: string },
  ) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  responseDir?: string;
};

export type StepRunOpts = {
  name: string;
  repoRoot: string;
  config: WorkflowsConfig;
  ctx: InvocationContext;
  deps: RunnerDeps;
  runId: string;
  workflowPath: string[];
  isEntry: boolean;
  /** Ordinal of the invoking workflow: step — persisted on nested history records. */
  parentOrdinal?: number;
  managedResponseFiles: string[];
  recorder: RunRecorder;
  onProgress?: (step: number, total: number, label: string, outcome?: string) => void;
  onStderr?: (text: string) => void;
  runSteps: RunSteps;
};

export type StepCtx = {
  step: WorkflowStep;
  stepIndex: number;
  values: TemplateNamespace;
  opts: StepRunOpts;
};

export type StepsResult =
  | { ok: true; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      aborted?: boolean;
      coordinationLost?: boolean;
      failure?: StepFailure;
    };

type RunSteps = (
  steps: WorkflowStep[],
  opts: StepRunOpts,
  values: TemplateNamespace,
) => Promise<StepsResult>;

const COORDINATION_CODES = new Set(["closed", "no_socket", "unreachable"]);

export class CoordinationError extends Error {
  constructor(action: string, detail: string) {
    super(
      `${action}: herdr coordination was lost (${detail}) — the action may still be active; panes were preserved and on_failure was skipped`,
    );
    this.name = "CoordinationError";
  }
}

export function isCoordinationError(err: unknown): boolean {
  return err instanceof HerdrError && COORDINATION_CODES.has(err.code);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap a dispatched herdr operation so transport loss becomes an uncertain-coordination outcome. */
export function dispatchFailure(action: string, err: unknown): StepOutcome {
  if (isCoordinationError(err)) {
    return {
      ok: false,
      error: new CoordinationError(action, errorText(err)).message,
      coordinationLost: true,
    };
  }
  return { ok: false, error: `${action}: ${errorText(err)}` };
}

/** Herdr split ratio is the first child's share and the created pane is the second child. */
export function sizeToFirstRatio(sizePercent: number): number {
  return (100 - sizePercent) / 100;
}

const AGENT_NAME_MAX = 32;

function normalizedPrefix(raw: string): string {
  const lowered = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "");
  return lowered || "agent";
}

export function generateAgentName(
  stepId: string | undefined,
  ordinal: number,
  suffix: string,
): string {
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "") || "0";
  const prefix = normalizedPrefix(stepId ?? `step-${ordinal}`);
  const room = Math.max(1, AGENT_NAME_MAX - tail.length - 1);
  return `${prefix.slice(0, room)}-${tail}`.slice(0, AGENT_NAME_MAX);
}

/** Repo-local scratch for agent-readable/writable run files (transcripts, prompts, responses). */
export function runScratchDir(repoRoot: string): string {
  return join(repoRoot, ".hwf", "tmp");
}

export function managedResponsePath(runId: string, stepIndex: number, responseDir: string): string {
  return join(responseDir, `${runId}-step-${stepIndex}.txt`);
}

/** Spill path for agent.prompt bodies that exceed AGENT_PROMPT_BYTE_LIMIT. */
export function managedPromptSpillPath(
  runId: string,
  stepIndex: number,
  responseDir: string,
): string {
  return join(responseDir, `${runId}-step-${stepIndex}-prompt.txt`);
}

export function appendResponseInstruction(prompt: string, path: string): string {
  return `${prompt}\n\nRequired: use your file-write tool to write your full answer as plain UTF-8 text to the absolute path ${path}, overwriting whatever is there. Do not finish until that file exists with your answer. Write nothing else to that path and do not create other files for it. Printing the answer in chat is not enough.`;
}

export function spilledPromptInstruction(spillPath: string): string {
  return `Read the absolute path ${spillPath} as UTF-8 and follow its instructions exactly. Do not invent content beyond that file.`;
}

export async function readManagedResponse(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError(
      "managed_response_missing",
      `managed response file was not written: ${path}`,
    );
  }
  const size = file.size;
  if (size > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError("managed response", size);
  const text = await file.text();
  assertUnderCaptureCap("managed response", text);
  if (!text.trim()) {
    throw new HerdrError("managed_response_empty", `managed response file is empty: ${path}`);
  }
  return text;
}

export async function herdrStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "herdr") return { ok: false, error: "internal: not a herdr step" };
  const params = substituteParams(action.params, c.values) ?? {};
  const invalid = validateHerdrInvocation(action.method, params);
  if (invalid) return { ok: false, error: invalid, details: { method: action.method } };
  try {
    const result = await c.opts.deps.herdrCall(action.method, params);
    return { ok: true, result };
  } catch (error) {
    const failure = dispatchFailure(`herdr ${action.method}`, error);
    return failure.ok ? failure : { ...failure, details: { method: action.method } };
  }
}
