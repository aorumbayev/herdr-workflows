export class WorkflowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLoadError";
  }
}

export function positioned(
  file: string,
  step: number | undefined,
  key: string | undefined,
  message: string,
): string {
  const parts = [file];
  if (step !== undefined) parts.push(`step ${step}`);
  if (key) parts.push(key);
  return `${parts.join(", ")}: ${message}`;
}

export function bail(
  file: string,
  step: number | undefined,
  key: string | undefined,
  message: string,
): never {
  throw new WorkflowLoadError(positioned(file, step, key, message));
}

export const WORKFLOW_FORMAT = "v1alpha1" as const;
type WorkflowFormat = typeof WORKFLOW_FORMAT;

export const IDENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const DURATION_RE = /^([1-9]\d*)(ms|s|m|h)$/;

export type ShellName = "sh" | "bash" | "zsh" | "pwsh" | "powershell" | "cmd";
export type PaneOpen = "tab" | "beside" | "below";
type PaneClose = "success" | "always";
export type PlatformName = "macos" | "linux" | "windows";

export type PaneSpec = {
  open: PaneOpen;
  target?: string;
  workspace?: string;
  size?: number;
  focus?: boolean;
  close?: PaneClose;
};

export type RetrySpec = {
  attempts: number;
  delayMs?: number;
};

export type WhenSpec =
  | { kind: "truthy"; path: string }
  | { kind: "eq"; path: string; value: string; negate: boolean };

export type RunPayload =
  | { form: "shell"; command: string; shell?: ShellName }
  | { form: "argv"; argv: string[] };

type AgentAction = {
  kind: "agent";
  prompt: string;
  using?: string;
  target?: string;
  cwd?: string;
  env?: Record<string, string>;
  pane?: PaneSpec;
  background?: boolean;
  timeoutMs?: number;
};

type RunAction = {
  kind: "run";
  payload: RunPayload;
  cwd?: string;
  env?: Record<string, string>;
  pane?: PaneSpec;
  background?: boolean;
  readyWhen?: string;
  timeoutMs?: number;
  retry?: RetrySpec;
};

type HerdrAction = {
  kind: "herdr";
  method: string;
  params?: Record<string, unknown>;
  retry?: RetrySpec;
};

type WorkflowAction = {
  kind: "workflow";
  name: string;
  inputs?: Record<string, string>;
};

export type StepAction = AgentAction | RunAction | HerdrAction | WorkflowAction;

export type WorkflowStep = {
  id?: string;
  when?: WhenSpec;
  continueOnError?: boolean;
  action: StepAction;
};

export type RecoveryAction =
  | Omit<AgentAction, "background">
  | Omit<RunAction, "background" | "retry">
  | Omit<HerdrAction, "retry">
  | WorkflowAction;

type InputType = "text" | "choice" | "profile";

export type DynamicChoice = { run: string[] };

export type InputSpec = {
  name: string;
  type: InputType;
  description?: string;
  default?: string;
  options?: string[];
  dynamicOptions?: DynamicChoice;
};

export type RawInputValue =
  | "text"
  | "profile"
  | string[]
  | {
      type?: InputType;
      description?: string;
      default?: string;
      options?: string[] | DynamicChoice;
    };

export type ReturnsSpec =
  | { kind: "template"; template: string }
  | { kind: "map"; fields: Record<string, string> };

export type TemplateRoot = "inputs" | "steps" | "context";

export type TemplatePath = {
  root: TemplateRoot;
  segments: string[];
};

type ManagedAgentResult = {
  response: string;
  agent: Record<string, unknown>;
  pane_id: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  failed: boolean;
};

type ReadinessResult = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
} & Record<string, unknown>;

type HerdrResult = Record<string, unknown>;

type ChildResult = unknown;

type NaturalStepResult =
  | ManagedAgentResult
  | CommandResult
  | ReadinessResult
  | HerdrResult
  | ChildResult;

export type TemplateNamespace = {
  inputs: Record<string, unknown>;
  steps: Record<string, NaturalStepResult>;
  context: Record<string, unknown>;
};

type ContextError = {
  message: string;
  workflow: string;
  action: "agent" | "run" | "herdr" | "workflow";
  step_number: number;
  workflow_path: string[];
  step_id?: string;
  details: Record<string, unknown>;
};

type InvocationContextValues = {
  workspace: string;
  tab: string;
  pane: string;
  worktree: string;
  agent: string;
  selection: string;
  platform: PlatformName;
  transcript?: string;
  transcript_file?: string;
  error?: ContextError;
};

export type LoadedWorkflow = {
  name: string;
  file: string;
  version: WorkflowFormat;
  title?: string;
  description?: string;
  hidden: boolean;
  steps: WorkflowStep[];
  inputs: InputSpec[];
  returns?: ReturnsSpec;
  onFailure?: RecoveryAction;
  repoOwned: boolean;
  needsTranscript: boolean;
  needsInvokingAgent: boolean;
};

export type WorkflowListEntry = {
  name: string;
  source: "repo" | "global";
  file: string;
  error?: string;
  hidden?: boolean;
  title?: string;
  description?: string;
  needsTranscript?: boolean;
  hasCommands?: boolean;
  sensitiveMethods?: string[];
  unresolvedChildren?: string[];
  inputs?: InputSpec[];
  repoOwned?: boolean;
  dynamicOptions?: boolean;
};
