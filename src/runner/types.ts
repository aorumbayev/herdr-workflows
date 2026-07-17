import type {
  agentLabel,
  agentStatus,
  herdrCall,
  layoutApply,
  notificationShow,
  paneRead,
  reportToken,
  waitOutput,
} from "../adapter/client";
import type { AgentsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { sessionText } from "../session";
import type { runShellStep } from "./shell";

export type RunnerDeps = {
  layoutApply: typeof layoutApply;
  herdrCall: typeof herdrCall;
  notificationShow: typeof notificationShow;
  runShell: typeof runShellStep;
  agentStatus: typeof agentStatus;
  agentLabel: typeof agentLabel;
  waitOutput: typeof waitOutput;
  paneRead: typeof paneRead;
  reportToken: typeof reportToken;
  sessionText: typeof sessionText;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  agentWaitPollMs?: number;
  agentWaitIdleGraceMs?: number;
};

export type StepRunOptions = {
  name: string;
  agents: AgentsConfig;
  ctx: InvocationContext;
  deps: RunnerDeps;
  runId: string;
  onProgress?: (step: number, total: number, label: string) => void;
  onStderr?: (text: string) => void;
};

export type StepResult = { ok: true; last: string } | { ok: false; error: string; last: string };
