import { randomUUID } from "node:crypto";
import type { AgentsConfig, SessionsConfig } from "./config";
import { buildPlaceholders, type InvocationContext } from "./context";
import { loadWorkflow } from "./workflows";
import { appendRunLog } from "./runlog";
import { defaultDeps, runSteps, type RunnerDeps, type StepResult } from "./runner/dispatch";
import { fail } from "./runner/fire";
import { runShellStep, SHELL_TIMEOUT_MS } from "./runner/shell";

export { runShellStep, SHELL_TIMEOUT_MS };
export type { RunnerDeps };

export type RunOptions = {
  name: string;
  repoRoot: string;
  agents: AgentsConfig;
  sessions?: SessionsConfig;
  ctx: InvocationContext;
  prompt?: string;
  deps?: Partial<RunnerDeps>;
  onProgress?: (step: number, total: number, label: string) => void;
  onStderr?: (text: string) => void;
};

export type RunResult = StepResult;

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const runId = randomUUID().slice(0, 8);
  const workflow = await loadWorkflow(opts.name, opts.repoRoot, Object.keys(opts.agents));
  const stepOpts = {
    name: workflow.name,
    agents: opts.agents,
    ctx: opts.ctx,
    deps,
    runId,
    onProgress: opts.onProgress,
    onStderr: opts.onStderr,
  };

  const failPrecondition = async (detail: string): Promise<RunResult> => {
    const error = await fail(deps, workflow.name, 0, detail);
    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: false,
      error,
    });
    return { ok: false, error, last: "" };
  };

  try {
    let session = "";
    // Extraction failure below still runs on_fail (recovery can fall back to {pane});
    // only launching without a pane fails hard — recovery would have no context either.
    let sessionFailure: string | undefined;
    if (workflow.needsSession) {
      if (!opts.ctx.paneId) {
        return await failPrecondition("session handoff must be launched from an agent pane");
      }
      try {
        session = await deps.sessionText(opts.ctx.paneId, opts.sessions ?? {});
      } catch (err) {
        sessionFailure = err instanceof Error ? err.message : String(err);
      }
    }

    let agent = "";
    if (workflow.needsInvokingAgent) {
      if (!opts.ctx.paneId) {
        return await failPrecondition("invoking agent unresolved — run from agent pane");
      }
      try {
        const label = await deps.agentLabel(opts.ctx.paneId);
        if (!opts.agents[label]) {
          return await failPrecondition(
            `invoking agent '${label}' not in config — add it under agents:`,
          );
        }
        agent = label;
      } catch (err) {
        return await failPrecondition(
          err instanceof Error ? err.message : "invoking agent unresolved — run from agent pane",
        );
      }
    }

    const base = await buildPlaceholders({
      ctx: opts.ctx,
      prompt: opts.prompt,
      last: "",
      error: "",
      session,
      agent,
    });

    const primary: StepResult = sessionFailure
      ? { ok: false, error: await fail(deps, workflow.name, 0, sessionFailure), last: "" }
      : await runSteps(workflow.steps, stepOpts, base);
    let result = primary;
    if (!primary.ok && workflow.onFail) {
      const recovery = await loadWorkflow(workflow.onFail, opts.repoRoot, Object.keys(opts.agents));
      // Same invocation snapshot into recovery — re-reading {pane} here would capture post-failure scrollback.
      const recoveryValues = { ...base, last: primary.last, error: primary.error };
      result = await runSteps(recovery.steps, { ...stepOpts, name: recovery.name }, recoveryValues);
    }
    await appendRunLog({
      ts: new Date().toISOString(),
      run: runId,
      workflow: workflow.name,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    });
    return result;
  } finally {
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
