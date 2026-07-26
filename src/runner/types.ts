import type {
  agentLabel,
  agentStatus,
  layoutApply,
  notificationShow,
  paneRead,
  reportToken,
  tabClose,
  waitOutput,
} from "../adapter/client";
import type { herdrCall } from "../adapter/rpc";
import type { AgentsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { sessionText } from "../session";
import type { runArgvStep, runShellStep } from "./shell";

export type RunnerDeps = {
  layoutApply: typeof layoutApply;
  herdrCall: typeof herdrCall;
  notificationShow: typeof notificationShow;
  runShell: typeof runShellStep;
  runArgv: typeof runArgvStep;
  agentStatus: typeof agentStatus;
  agentLabel: typeof agentLabel;
  waitOutput: typeof waitOutput;
  paneRead: typeof paneRead;
  reportToken: typeof reportToken;
  sessionText: typeof sessionText;
  tabClose: typeof tabClose;
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
  onProgress?: (
    step: number,
    total: number,
    label: string,
    outcome?: "ok" | "skip" | "fail",
  ) => void;
  onStderr?: (text: string) => void;
};

export type StepResult =
  | { ok: true; skipped?: boolean; failures?: string[] }
  | {
      ok: false;
      error: string;
      failures?: string[];
      /** true when a non-allow_fail step aborted */ aborted?: boolean;
    };
