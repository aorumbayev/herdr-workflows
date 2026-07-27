import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProfile, type AgentProfile } from "../../config";
import { substituteText } from "../../workflow/parse";
import type { StepAction } from "../../workflow/types";
import {
  appendResponseInstruction,
  dispatchFailure,
  generateAgentName,
  managedResponsePath,
  readManagedResponse,
  type StepCtx,
  type StepOutcome,
} from "../context";
import { placeEmptyPane, type PlacedPane } from "./pane";

type AgentAction = Extract<StepAction, { kind: "agent" }>;

const TURN_TIMEOUT_MS = 1_800_000;
const POLL_MS = 1_000;
const SETTLED = new Set(["idle", "done"]);

type ProfileChoice =
  | { ok: true; name: string; profile: AgentProfile }
  | { ok: false; error: string };

function chooseProfile(c: StepCtx, action: AgentAction): ProfileChoice {
  const name =
    action.using !== undefined
      ? substituteText(action.using, c.values)
      : c.opts.config.default_profile;
  if (!name) {
    return { ok: false, error: "agent: no using: profile and no default_profile is configured" };
  }
  const profile = resolveProfile(c.opts.config, name);
  if (!profile) return { ok: false, error: `agent: unknown profile '${name}'` };
  return { ok: true, name, profile };
}

async function preparedResponsePath(c: StepCtx): Promise<string> {
  const path = managedResponsePath(c.opts.runId, c.stepIndex, c.opts.deps.responseDir);
  await mkdir(dirname(path), { recursive: true });
  return path;
}

async function fileHasText(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return (await file.exists()) && file.size > 0;
}

type TurnWait = { settled: true } | { settled: false; error: string };

async function awaitManagedTurn(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
): Promise<TurnWait> {
  const deps = c.opts.deps;
  const deadline = deps.now() + timeoutMs;
  let notifiedBlocked = false;
  for (;;) {
    const status = await deps.agentStatus(target);
    if (SETTLED.has(status) && (await fileHasText(path))) return { settled: true };
    if (status !== "blocked") notifiedBlocked = false;
    else if (!notifiedBlocked) {
      notifiedBlocked = true;
      await deps
        .notificationShow(
          `herdr-workflows: ${c.opts.name} agent blocked`,
          `${target} is waiting for input at step ${c.stepIndex}`,
        )
        .catch(() => undefined);
    }
    if (deps.now() >= deadline) {
      return {
        settled: false,
        error: `agent turn on '${target}' did not settle with a managed response within ${timeoutMs / 1000}s (last status ${status})`,
      };
    }
    await deps.sleep(POLL_MS);
  }
}

async function managedResult(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
  paneId?: string,
): Promise<StepOutcome> {
  const wait = await awaitManagedTurn(c, target, path, timeoutMs);
  if (!wait.settled) {
    return {
      ok: false,
      error: wait.error,
      details: { target, ...(paneId ? { pane_id: paneId } : {}) },
    };
  }
  const response = await readManagedResponse(path);
  const agent = await c.opts.deps.agentInfo(target);
  const pane = paneId ?? (typeof agent.pane_id === "string" ? agent.pane_id : "");
  return { ok: true, result: { response, agent, pane_id: pane } };
}

async function submitPrompt(c: StepCtx, target: string, text: string): Promise<void> {
  await c.opts.deps.herdrCall("agent.prompt", { target, text });
}

async function closePane(c: StepCtx, placed: PlacedPane): Promise<void> {
  await c.opts.deps.paneClose(placed.pane_id).catch(() => undefined);
}

async function startNewAgent(
  c: StepCtx,
  action: AgentAction,
  profile: AgentProfile,
): Promise<{ name: string; placed: PlacedPane }> {
  const pane = action.pane ?? { open: "tab" as const };
  const sub = (text?: string) => (text === undefined ? undefined : substituteText(text, c.values));
  const placed = await placeEmptyPane({
    open: pane.open,
    target: sub(pane.target),
    workspace: sub(pane.workspace),
    size: pane.size,
    focus: pane.focus ?? action.background !== true,
    cwd: action.cwd !== undefined ? substituteText(action.cwd, c.values) : c.opts.ctx.cwd,
    env: Object.fromEntries(
      Object.entries(action.env ?? {}).map(([k, v]) => [k, substituteText(v, c.values)]),
    ),
    label: c.step.id ?? "hwf-agent",
    deps: c.opts.deps,
    invocation: c.opts.ctx,
  });
  const name = generateAgentName(c.step.id, c.stepIndex, c.opts.runId);
  await c.opts.deps.herdrCall("agent.start", {
    name,
    kind: profile.kind,
    pane_id: placed.pane_id,
    args: profile.args ?? [],
  });
  return { name, placed };
}

async function newAgentTurn(c: StepCtx, action: AgentAction): Promise<StepOutcome> {
  const chosen = chooseProfile(c, action);
  if (!chosen.ok) return { ok: false, error: chosen.error };
  let placement: { name: string; placed: PlacedPane } | undefined;
  const close = action.pane?.close;
  try {
    placement = await startNewAgent(c, action, chosen.profile);
    const prompt = substituteText(action.prompt, c.values);
    if (action.background === true) {
      await submitPrompt(c, placement.name, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(c);
    await submitPrompt(c, placement.name, appendResponseInstruction(prompt, path));
    const outcome = await managedResult(
      c,
      placement.name,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      placement.placed.pane_id,
    );
    if (outcome.ok && close === "success") await closePane(c, placement.placed);
    return outcome;
  } catch (error) {
    return dispatchFailure(`agent (profile ${chosen.name})`, error);
  } finally {
    if (close === "always" && placement) await closePane(c, placement.placed);
  }
}

async function targetTurn(
  c: StepCtx,
  action: AgentAction,
  rawTarget: string,
): Promise<StepOutcome> {
  const target = substituteText(rawTarget, c.values);
  if (!target) return { ok: false, error: "agent: target resolved to an empty value" };
  try {
    const status = await c.opts.deps.agentStatus(target);
    if (!SETTLED.has(status)) {
      return {
        ok: false,
        error: `agent target '${target}' is ${status} — herdr cannot correlate a queued turn; use 'herdr: agent.prompt' to queue work deliberately`,
        details: { target, status },
      };
    }
    const prompt = substituteText(action.prompt, c.values);
    if (action.background === true) {
      await submitPrompt(c, target, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(c);
    await submitPrompt(c, target, appendResponseInstruction(prompt, path));
    return await managedResult(c, target, path, action.timeoutMs ?? TURN_TIMEOUT_MS);
  } catch (error) {
    return dispatchFailure(`agent (target ${target})`, error);
  }
}

export async function agentStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "agent") return { ok: false, error: "internal: not an agent step" };
  if (action.target !== undefined) return targetTurn(c, action, action.target);
  return newAgentTurn(c, action);
}
