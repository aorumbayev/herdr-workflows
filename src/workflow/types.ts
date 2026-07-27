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

export const BUILTIN_NAMES = [
  "pane",
  "selection",
  "prompt",
  "session",
  "session_file",
  "source_tab",
  "agent",
  "error",
  "item",
  "index",
  "attempt",
  "platform",
] as const;

/** Flat namespace: builtins + inputs + out/as bindings. */
export type PlaceholderValues = Record<string, string>;

export type InputSpec = {
  name: string;
  label: string;
  desc?: string;
  /** Present → choice input; absent → free text. Resolved lines (never a shell command string). */
  options?: string[];
  /** Dynamic choices exist but were intentionally not executed during listing. */
  dynamicOptions?: boolean;
  default?: string;
};

export type Placement = "here" | "tab" | "right" | "down";
export type ShellName = "sh" | "bash" | "zsh" | "pwsh" | "powershell" | "cmd";

export type WaitSpec = { kind: "block" } | { kind: "detach" } | { kind: "regex"; pattern: string };

export type Guard =
  | { kind: "nonempty"; name: string; negate: boolean }
  | { kind: "eq"; name: string; value: string; negate: boolean }
  | { kind: "argv"; argv: string[] }
  | { kind: "shell"; command: string };

export type ForSource =
  | { kind: "list"; items: string[] }
  | { kind: "sh"; command: string }
  | { kind: "binding"; name: string };

export type RetrySpec = {
  times: number;
  delaySec?: number;
  until?: Guard;
  reset?: string;
};

export type OutSpec =
  | { kind: "text"; name: string }
  | { kind: "map"; fields: Record<string, string> };

export type RunPayload =
  | { form: "scalar" | "block"; command: string; shell?: ShellName }
  | { form: "argv"; argv: string[] };

export type FlatStep = {
  name?: string;
  action:
    | {
        kind: "run";
        payload: RunPayload;
        in: Placement;
        cwd?: string;
        env?: Record<string, string>;
        ratio?: number;
        focus?: boolean;
      }
    | {
        kind: "agent";
        agent: string;
        prompt?: string;
        in: Placement;
        cwd?: string;
        env?: Record<string, string>;
        ratio?: number;
        focus?: boolean;
        close?: boolean;
      }
    | {
        kind: "primitive";
        method: string;
        params?: Record<string, unknown>;
      }
    | {
        kind: "include";
        workflow: string;
        with: Record<string, string>;
        defaults: Record<string, string>;
        steps: FlatStep[];
        exportedOuts: string[];
      };
  out?: OutSpec;
  when?: Guard;
  for?: ForSource;
  as?: string;
  retry?: RetrySpec;
  wait: WaitSpec;
  timeoutMs?: number;
  allowFail?: boolean;
  onError?: { name: string; steps: FlatStep[] };
};

export type LoadedWorkflow = {
  name: string;
  file: string;
  desc?: string;
  /** Runnable via `hwf run`, kept out of the picker — the background half of a split workflow. */
  hidden: boolean;
  steps: FlatStep[];
  inputs: InputSpec[];
  onError?: string;
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
  hidden?: boolean;
  needsPrompt?: boolean;
  inputs?: InputSpec[];
  repoOwned?: boolean;
  dynamicOptions?: boolean;
};
