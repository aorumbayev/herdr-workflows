import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProfile, type AgentProfile } from "../../config";
import { HerdrError } from "../../herdr";
import { substituteText } from "../../workflow/parse";
import type { StepAction } from "../../workflow/types";
import {
  appendResponseInstruction,
  dispatchFailure,
  generateAgentName,
  managedResponsePath,
  readManagedResponse,
  type RunnerDeps,
  type StepCtx,
  type StepOutcome,
} from "../context";
import { placeEmptyPane, type PlacedPane } from "./pane";

type AgentAction = Extract<StepAction, { kind: "agent" }>;

const TURN_TIMEOUT_MS = 1_800_000;
const POLL_MS = 1_000;
const SETTLED = new Set(["idle", "done"]);
/** New-agent only: consecutive settled+empty polls before missing-response failure. */
const SETTLED_EMPTY_GRACE_POLLS = 2;
const SHELL_READY_DEADLINE_MS = 5_000;
const SHELL_READY_POLL_MS = 50;
/** Socket agent.start returns at launch_pending; CLI waits for interactive_ready (default 30s). */
const AGENT_INTERACTIVE_DEADLINE_MS = 30_000;
const AGENT_INTERACTIVE_POLL_MS = 100;

function processInfoRecord(result: Record<string, unknown>): Record<string, unknown> {
  const info = result.process_info;
  return typeof info === "object" && info !== null ? (info as Record<string, unknown>) : result;
}

/** shell_pid alone in its FG group — herdr available_pane_shell via pane.process_info. */
function isAvailableShellProcessInfo(info: Record<string, unknown>): boolean {
  const shellPid = info.shell_pid;
  if (typeof shellPid !== "number") return false;
  if (info.foreground_process_group_id !== shellPid) return false;
  const procs = info.foreground_processes;
  if (!Array.isArray(procs) || procs.length !== 1) return false;
  const only = procs[0];
  return typeof only === "object" && only !== null && (only as { pid?: unknown }).pid === shellPid;
}

async function startAgentWhenShellReady(
  deps: RunnerDeps,
  params: { name: string; kind: string; pane_id: string; args: string[] },
): Promise<void> {
  const deadline = deps.now() + SHELL_READY_DEADLINE_MS;
  let lastBusy: HerdrError | undefined;
  while (deps.now() < deadline) {
    let shellReady = false;
    try {
      const result = await deps.herdrCall("pane.process_info", { pane_id: params.pane_id });
      shellReady = isAvailableShellProcessInfo(processInfoRecord(result));
    } catch {
      shellReady = false;
    }
    if (shellReady) {
      try {
        await deps.herdrCall("agent.start", params);
        return;
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
        lastBusy = error;
      }
    }
    await deps.sleep(SHELL_READY_POLL_MS);
  }
  if (lastBusy) throw lastBusy;
  await deps.herdrCall("agent.start", params);
}

async function awaitAgentInteractiveReady(deps: RunnerDeps, name: string): Promise<void> {
  const deadline = deps.now() + AGENT_INTERACTIVE_DEADLINE_MS;
  for (;;) {
    const agent = await deps.agentInfo(name);
    if (agent.interactive_ready === true) return;
    if (agent.launch_pending === false) {
      throw new HerdrError(
        "agent_start_failed",
        "agent process exited before becoming interactive",
      );
    }
    if (deps.now() >= deadline) {
      throw new HerdrError(
        "agent_start_timeout",
        `agent '${name}' did not become interactive within ${AGENT_INTERACTIVE_DEADLINE_MS / 1000}s`,
      );
    }
    await deps.sleep(AGENT_INTERACTIVE_POLL_MS);
  }
}

type ProfileChoice =
  | { ok: true; name: string; profile: AgentProfile }
  | { ok: false; error: string };

/** Target mode keeps waiting for the exact managed file; new-agent fails after a short settled grace. */
type ManagedWaitMode = "new-agent" | "target";

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
  c.opts.managedResponseFiles.push(path);
  return path;
}

async function fileHasText(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return (await file.exists()) && file.size > 0;
}

async function missingManagedError(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return `managed response file was not written: ${path}`;
  return `managed response file is empty: ${path}`;
}

type TurnWait =
  | { settled: true; blocked: boolean }
  | { settled: false; error: string; blocked: boolean };

async function awaitManagedTurn(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
): Promise<TurnWait> {
  const deps = c.opts.deps;
  const deadline = deps.now() + timeoutMs;
  let notifiedBlocked = false;
  let sawBlocked = false;
  let sawActive = false;
  let settledEmptyPolls = 0;
  for (;;) {
    const status = await deps.agentStatus(target);
    const hasText = await fileHasText(path);
    if (SETTLED.has(status) && hasText) return { settled: true, blocked: sawBlocked };
    if (!SETTLED.has(status)) sawActive = true;

    // Skip pre-work idle: agent.start leaves the agent idle until the prompt is taken.
    const emptySettled =
      mode === "new-agent" && SETTLED.has(status) && !hasText && (status === "done" || sawActive);
    if (emptySettled) {
      settledEmptyPolls += 1;
      if (settledEmptyPolls > SETTLED_EMPTY_GRACE_POLLS) {
        return {
          settled: false,
          error: await missingManagedError(path),
          blocked: sawBlocked,
        };
      }
    } else {
      settledEmptyPolls = 0;
    }

    if (status !== "blocked") notifiedBlocked = false;
    else {
      sawBlocked = true;
      if (!notifiedBlocked) {
        notifiedBlocked = true;
        await deps
          .notificationShow(
            `herdr-workflows: ${c.opts.name} agent blocked`,
            `${target} is waiting for input at step ${c.stepIndex}`,
          )
          .catch(() => undefined);
      }
    }

    if (deps.now() >= deadline) {
      return {
        settled: false,
        error: `agent turn on '${target}' did not settle with a managed response within ${timeoutMs / 1000}s (last status ${status})`,
        blocked: sawBlocked,
      };
    }
    await deps.sleep(POLL_MS);
  }
}

function agentDetails(parts: {
  profile?: string;
  kind?: string;
  target?: string;
  pane?: PlacedPane;
  pane_id?: string;
  status?: string;
}): Record<string, unknown> {
  return {
    ...(parts.profile !== undefined ? { profile: parts.profile } : {}),
    ...(parts.kind !== undefined ? { kind: parts.kind } : {}),
    ...(parts.target !== undefined ? { target: parts.target } : {}),
    ...(parts.pane
      ? {
          pane_id: parts.pane.pane_id,
          tab_id: parts.pane.tab_id,
          workspace_id: parts.pane.workspace_id,
        }
      : {}),
    ...(parts.pane_id !== undefined && !parts.pane ? { pane_id: parts.pane_id } : {}),
    ...(parts.status !== undefined ? { status: parts.status } : {}),
  };
}

async function managedResult(
  c: StepCtx,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
  details: Record<string, unknown>,
): Promise<StepOutcome> {
  const wait = await awaitManagedTurn(c, target, path, timeoutMs, mode);
  if (!wait.settled) {
    return {
      ok: false,
      error: wait.error,
      details,
      ...(wait.blocked ? { blocked: true } : {}),
    };
  }
  try {
    const response = await readManagedResponse(path);
    const agent = await c.opts.deps.agentInfo(target);
    const pane =
      typeof details.pane_id === "string"
        ? details.pane_id
        : typeof agent.pane_id === "string"
          ? agent.pane_id
          : "";
    return {
      ok: true,
      result: { response, agent, pane_id: pane },
      ...(wait.blocked ? { blocked: true } : {}),
    };
  } catch (error) {
    const message =
      error instanceof HerdrError ? error.message : `managed response: ${String(error)}`;
    return {
      ok: false,
      error: message,
      details,
      ...(wait.blocked ? { blocked: true } : {}),
    };
  }
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
  await startAgentWhenShellReady(c.opts.deps, {
    name,
    kind: profile.kind,
    pane_id: placed.pane_id,
    args: profile.args ?? [],
  });
  await awaitAgentInteractiveReady(c.opts.deps, name);
  return { name, placed };
}

async function newAgentTurn(c: StepCtx, action: AgentAction): Promise<StepOutcome> {
  const chosen = chooseProfile(c, action);
  if (!chosen.ok) return { ok: false, error: chosen.error };
  let placement: { name: string; placed: PlacedPane } | undefined;
  const close = action.pane?.close;
  const baseDetails = () =>
    agentDetails({
      profile: chosen.name,
      kind: chosen.profile.kind,
      ...(placement ? { target: placement.name, pane: placement.placed } : {}),
    });
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
      "new-agent",
      baseDetails(),
    );
    if (outcome.ok && close === "success") await closePane(c, placement.placed);
    return outcome;
  } catch (error) {
    const failure = dispatchFailure(`agent (profile ${chosen.name})`, error);
    return failure.ok ? failure : { ...failure, details: baseDetails() };
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
  const details = agentDetails({ target });
  try {
    const status = await c.opts.deps.agentStatus(target);
    if (!SETTLED.has(status)) {
      return {
        ok: false,
        error: `agent target '${target}' is ${status} — herdr cannot correlate a queued turn; use 'herdr: agent.prompt' to queue work deliberately`,
        details: agentDetails({ target, status }),
      };
    }
    const prompt = substituteText(action.prompt, c.values);
    if (action.background === true) {
      await submitPrompt(c, target, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(c);
    await submitPrompt(c, target, appendResponseInstruction(prompt, path));
    return await managedResult(
      c,
      target,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      "target",
      details,
    );
  } catch (error) {
    const failure = dispatchFailure(`agent (target ${target})`, error);
    return failure.ok ? failure : { ...failure, details };
  }
}

export async function agentStep(c: StepCtx): Promise<StepOutcome> {
  const action = c.step.action;
  if (action.kind !== "agent") return { ok: false, error: "internal: not an agent step" };
  if (action.target !== undefined) return targetTurn(c, action, action.target);
  return newAgentTurn(c, action);
}
