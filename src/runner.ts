import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentsConfig, SessionsConfig } from "./config";
import { buildPlaceholders, type InvocationContext } from "./context";
import { appendRunLog } from "./runlog";
import { defaultDeps, runSteps } from "./runner/dispatch";
import { fail } from "./runner/fire";
import { resolveInputValues } from "./runner/inputs";
import { resolvePreflight } from "./runner/preflight";
import type { RunnerDeps, StepResult } from "./runner/types";
import type { LoadedWorkflow } from "./workflows/types";
import { loadWorkflow } from "./workflows/load";

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
  onProgress?: (
    step: number,
    total: number,
    label: string,
    outcome?: "ok" | "skip" | "fail",
  ) => void;
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
    return { ok: false, error };
  };

  let sessionFile = "";
  try {
    const inputs = resolveInputValues(workflow.inputs, opts.inputs);
    if (!inputs.ok) return await failPrecondition(inputs.error);

    const pre = await resolvePreflight(workflow, opts.ctx, opts.agents, opts.sessions ?? {}, deps);
    if (!pre.ok) return await failPrecondition(pre.error);

    if (pre.session) {
      sessionFile = join(tmpdir(), `hwf-session-${runId}.txt`);
      await Bun.write(sessionFile, pre.session);
    }

    const base = await buildPlaceholders({
      ctx: opts.ctx,
      prompt: opts.prompt,
      error: "",
      session: pre.session,
      sessionFile,
      agent: pre.agent,
      inputs: inputs.values,
    });

    // Session extraction failure is a hard abort before steps — does not trigger on_error.
    if (pre.sessionFailure) {
      return await failPrecondition(pre.sessionFailure);
    }

    const primary = await runSteps(workflow.steps, stepOpts, base);
    let result = primary;
    if (!primary.ok && primary.aborted && workflow.recovery) {
      const recoveryValues = { ...base, error: primary.error };
      const recovery = await runSteps(
        workflow.recovery.steps,
        { ...stepOpts, name: workflow.recovery.name },
        recoveryValues,
      );
      result = recovery.ok ? { ok: false, error: primary.error } : recovery;
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
    if (sessionFile) await rm(sessionFile, { force: true }).catch(() => undefined);
    if (opts.ctx.paneId) {
      void deps.reportToken(opts.ctx.paneId, null).catch(() => undefined);
    }
  }
}
