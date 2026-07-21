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

export type PlaceholderValues = {
  pane: string;
  selection: string;
  prompt: string;
  last: string;
  error: string;
  session: string;
  tab: string;
  prev_tab: string;
  agent: string;
  inputs: Record<string, string>;
};

export type InputSpec = {
  name: string;
  label: string;
  /** Present → choice input; absent → free text. Resolved lines (never a shell command string). */
  options?: string[];
  /** Dynamic choices exist but were intentionally not executed during listing. */
  dynamicOptions?: boolean;
  default?: string;
};

export type FlatStep =
  | { verb: "shell"; command: string; stdin?: string }
  | { verb: "open"; command: string; waitFor?: string; timeoutMs?: number }
  | { verb: "agent"; name: string; prompt?: string; wait?: true; timeoutMs?: number }
  | { verb: "herdr"; method: string; params?: Record<string, unknown> };

export type LoadedWorkflow = {
  name: string;
  file: string;
  steps: FlatStep[];
  inputs: InputSpec[];
  onFail?: string;
  recovery?: { name: string; steps: FlatStep[] };
  repoOwned: boolean;
  needsPrompt: boolean;
  needsSession: boolean;
  needsInvokingAgent: boolean;
};

export type WorkflowListEntry = {
  name: string;
  source: "repo" | "global";
  file: string;
  error?: string;
  needsPrompt?: boolean;
  inputs?: InputSpec[];
  repoOwned?: boolean;
  dynamicOptions?: boolean;
};
