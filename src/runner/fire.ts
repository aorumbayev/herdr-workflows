import { HerdrError } from "../adapter/client";
import { fillAgentArgv } from "../config";
import { PANE_READ_LINES, PANE_READ_SOURCE } from "../pane-read";
import { substitute, substituteParams, type FlatStep, type PlaceholderValues } from "../workflows";
import { AGENT_INPUT_RE } from "../workflows/inputs";
import { waitAgentDone } from "./agent-wait";
import { shellArgv } from "./shell";
import type { RunnerDeps, StepResult, StepRunOptions } from "./types";

export type FireOutcome = { failed?: StepResult; last?: string; tabId?: string };

const INVOKING_AGENT = "{agent}";

async function fail(
  deps: RunnerDeps,
  workflow: string,
  step: number,
  detail: string,
): Promise<string> {
  const text = `step ${step}: ${detail}`;
  const body = text.length > 500 ? `…${text.slice(-500)}` : text;
  await deps.notificationShow(`herdr-workflows: ${workflow} failed`, body).catch(() => undefined);
  return body;
}

function autofill(
  params: Record<string, unknown> | undefined,
  ctx: StepRunOptions["ctx"],
): Record<string, unknown> {
  const out = { ...params };
  if (out.pane_id === undefined && ctx.paneId) out.pane_id = ctx.paneId;
  if (out.tab_id === undefined && ctx.tabId) out.tab_id = ctx.tabId;
  if (out.workspace_id === undefined && ctx.workspaceId) out.workspace_id = ctx.workspaceId;
  return out;
}

function resolveAgentName(stepName: string, values: PlaceholderValues): string {
  if (stepName === INVOKING_AGENT) return values.agent;
  const m = AGENT_INPUT_RE.exec(stepName);
  return m ? (values.inputs[m[1]!] ?? "") : stepName;
}

async function fireOpen(
  opts: StepRunOptions,
  step: FlatStep & { verb: "open" },
): Promise<FireOutcome> {
  const label = step.command.split(/\s+/)[0] || "open";
  const applied = await opts.deps.layoutApply({
    workspaceId: opts.ctx.workspaceId,
    tabLabel: label,
    cwd: opts.ctx.cwd,
    command: shellArgv(step.command),
    label,
    focus: true,
  });
  if (step.waitFor !== undefined) {
    await opts.deps.waitOutput(applied.paneId, step.waitFor, step.timeoutMs!);
  }
  return { tabId: applied.tabId };
}

async function fireAgent(
  opts: StepRunOptions,
  step: FlatStep & { verb: "agent" },
  values: PlaceholderValues,
  n: number,
  last: string,
): Promise<FireOutcome | undefined> {
  const name = resolveAgentName(step.name, values);
  if (step.name === INVOKING_AGENT && !name) {
    return {
      failed: {
        ok: false,
        error: await fail(
          opts.deps,
          opts.name,
          n,
          "invoking agent unresolved — run from agent pane",
        ),
        last,
      },
    };
  }
  const template = opts.agents[name];
  if (!template) {
    return {
      failed: {
        ok: false,
        error: await fail(opts.deps, opts.name, n, `unknown agent '${name}'`),
        last,
      },
    };
  }
  const prompt = step.prompt !== undefined ? substitute(step.prompt, values) : "";
  const applied = await opts.deps.layoutApply({
    workspaceId: opts.ctx.workspaceId,
    tabLabel: name,
    cwd: opts.ctx.cwd,
    command: fillAgentArgv(template, prompt),
    label: name,
    focus: true,
  });
  // Close source only after target opened — failure above leaves original tab intact.
  if (step.closeSource && opts.ctx.tabId) {
    await opts.deps.tabClose(opts.ctx.tabId);
  }
  if (!step.wait) return { tabId: applied.tabId };
  await waitAgentDone(applied.paneId, step.timeoutMs!, {
    agentStatus: opts.deps.agentStatus,
    sleep: opts.deps.sleep ?? ((ms) => Bun.sleep(ms)),
    now: opts.deps.now,
    pollMs: opts.deps.agentWaitPollMs,
    idleGraceMs: opts.deps.agentWaitIdleGraceMs,
    onBlocked: () =>
      opts.deps.notificationShow(
        `herdr-workflows: ${opts.name} waiting`,
        `agent blocked on step ${n} — needs your input`,
      ),
  });
  const text = await opts.deps.paneRead(applied.paneId, {
    source: PANE_READ_SOURCE,
    lines: PANE_READ_LINES,
  });
  return { last: text.trim(), tabId: applied.tabId };
}

export async function fire(
  opts: StepRunOptions,
  step: FlatStep & { verb: "open" | "agent" | "herdr" },
  values: PlaceholderValues,
  n: number,
  last: string,
): Promise<FireOutcome | undefined> {
  try {
    if (step.verb === "open") return await fireOpen(opts, step);
    if (step.verb === "agent") return await fireAgent(opts, step, values, n, last);
    await opts.deps.herdrCall(
      step.method,
      autofill(substituteParams(step.params, values), opts.ctx),
    );
  } catch (error) {
    const detail =
      error instanceof HerdrError || error instanceof Error ? error.message : String(error);
    return { failed: { ok: false, error: await fail(opts.deps, opts.name, n, detail), last } };
  }
}

export { fail };
