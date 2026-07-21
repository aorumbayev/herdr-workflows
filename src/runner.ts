import { randomUUID } from "node:crypto";
import type { AgentsConfig, SessionsConfig } from "./config";
import { buildPlaceholders, type InvocationContext } from "./context";
import { loadWorkflow, type LoadedWorkflow } from "./workflows";
import { appendRunLog } from "./runlog";
import { defaultDeps, runSteps, type RunnerDeps, type StepResult } from "./runner/dispatch";
import { fail } from "./runner/fire";
import { resolveInputValues } from "./runner/inputs";
import { resolvePreflight } from "./runner/preflight";
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
  inputs?: Record<string, string>;
  workflow?: LoadedWorkflow;
  deps?: Partial<RunnerDeps>;
  onProgress?: (step: number, total: number, label: string) => void;
  onStderr?: (text: string) => void;
};

export type RunResult = StepResult;

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const runId = randomUUID().slice(0, 8);
  const workflow =
    opts.workflow ?? (await loadWorkflow(opts.name, opts.repoRoot, Object.keys(opts.agents)));
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
    const inputs = resolveInputValues(workflow.inputs, opts.inputs);
    if (!inputs.ok) return await failPrecondition(inputs.error);

    const pre = await resolvePreflight(workflow, opts.ctx, opts.agents, opts.sessions ?? {}, deps);
    if (!pre.ok) return await failPrecondition(pre.error);

    const base = await buildPlaceholders({
      ctx: opts.ctx,
      prompt: opts.prompt,
      last: "",
      error: "",
      session: pre.session,
      agent: pre.agent,
      inputs: inputs.values,
    });

    const primary: StepResult = pre.sessionFailure
      ? { ok: false, error: await fail(deps, workflow.name, 0, pre.sessionFailure), last: "" }
      : await runSteps(workflow.steps, stepOpts, base);
    let result = primary;
    if (!primary.ok && workflow.recovery) {
      // Same invocation snapshot into recovery — re-reading {pane} here would capture post-failure scrollback.
      const recoveryValues = { ...base, last: primary.last, error: primary.error };
      result = await runSteps(
        workflow.recovery.steps,
        { ...stepOpts, name: workflow.recovery.name },
        recoveryValues,
      );
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
