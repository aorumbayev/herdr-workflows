import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  configPathsHint,
  globalConfigPath,
  repoConfigPath,
  resolveProfile,
  type AgentProfile,
} from "../../config";
import { HerdrError } from "../../host";
import { AGENT_PROMPT_BYTE_LIMIT, assertUnderCaptureCap } from "../../limits";
import { substituteText } from "../../workflow/template";
import type { StepAction } from "../../workflow/types";
import {
  appendResponseInstruction,
  dispatchFailure,
  generateAgentName,
  managedPromptSpillPath,
  managedResponsePath,
  readManagedResponse,
  runScratchDir,
  spilledPromptInstruction,
  type RunnerDeps,
  type StepCtx,
  type StepOutcome,
} from "../context";
import { placeEmptyPane, type PlacedPane } from "./pane";
import { resolvePaneOpen } from "./shell";

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
/**
 * Fresh agents (esp. opencode) can report interactive_ready before they accept input.
 * Wait this long after each agent.prompt for status to leave idle.
 */
const SUBMIT_PICKUP_DEADLINE_MS = 10_000;
const SUBMIT_PICKUP_POLL_MS = 100;
/** After pickup wait fails, Enter once for bracketed-paste stall, then wait again briefly. */
const SUBMIT_ENTER_FOLLOWUP_MS = 5_000;
const SUBMIT_MAX_ATTEMPTS = 3;
const SUBMIT_RETRY_BACKOFF_MS = 2_000;

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

async function chooseProfile(c: StepCtx, action: AgentAction): Promise<ProfileChoice> {
  const name =
    action.using !== undefined
      ? substituteText(action.using, c.values)
      : c.opts.config.default_profile;
  if (!name) {
    const hint = configPathsHint(await globalConfigPath(), repoConfigPath(c.opts.repoRoot));
    return {
      ok: false,
      error: `agent: no using: profile and no default_profile is configured (${hint}); run \`hwf init\` or \`hwf init --global\``,
    };
  }
  const profile = resolveProfile(c.opts.config, name);
  if (!profile) return { ok: false, error: `agent: unknown profile '${name}'` };
  return { ok: true, name, profile };
}

function responseDirOf(c: StepCtx): string {
  return c.opts.deps.responseDir ?? runScratchDir(c.opts.repoRoot);
}

async function preparedResponsePath(c: StepCtx): Promise<string> {
  const path = managedResponsePath(c.opts.runId, c.stepIndex, responseDirOf(c));
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

/** Evidence the agent accepted input (not still sitting on a pristine idle welcome). */
function promptPickedUp(status: string, before: string): boolean {
  if (status === "working" || status === "blocked") return true;
  return status !== "idle" && status !== before;
}

async function waitForPromptPickup(
  deps: RunnerDeps,
  target: string,
  before: string,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = deps.now() + deadlineMs;
  while (deps.now() < deadline) {
    const status = await deps.agentStatus(target);
    if (promptPickedUp(status, before)) return true;
    await deps.sleep(SUBMIT_PICKUP_POLL_MS);
  }
  return promptPickedUp(await deps.agentStatus(target), before);
}

/** Spill oversized bodies so agent.prompt does not silently drop them. */
async function maybeSpillAgentPrompt(c: StepCtx, text: string): Promise<string> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= AGENT_PROMPT_BYTE_LIMIT) return text;
  assertUnderCaptureCap("agent prompt", text);
  const spill = managedPromptSpillPath(c.opts.runId, c.stepIndex, responseDirOf(c));
  await mkdir(dirname(spill), { recursive: true, mode: 0o700 });
  await writeFile(spill, text, { mode: 0o600 });
  c.opts.managedResponseFiles.push(spill);
  return spilledPromptInstruction(spill);
}

/**
 * Submit until the agent leaves idle, re-sending the full prompt when a cold agent drops it.
 * Enter nudge only handles the separate bracketed-paste case (text present, not submitted).
 */
async function submitPrompt(c: StepCtx, target: string, text: string): Promise<void> {
  const deps = c.opts.deps;
  const body = await maybeSpillAgentPrompt(c, text);
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    // A slow-but-successful earlier submit may land during backoff — never double-prompt.
    if (attempt > 1 && promptPickedUp(await deps.agentStatus(target), "idle")) return;
    const before = await deps.agentStatus(target);
    await deps.herdrCall("agent.prompt", { target, text: body });
    if (await waitForPromptPickup(deps, target, before, SUBMIT_PICKUP_DEADLINE_MS)) return;
    // Paste stall: text may be in the composer without an Enter. Never re-prompt if this wakes it.
    await deps.herdrCall("agent.send_keys", { target, keys: ["enter"] });
    if (await waitForPromptPickup(deps, target, before, SUBMIT_ENTER_FOLLOWUP_MS)) return;
    if (attempt < SUBMIT_MAX_ATTEMPTS) await deps.sleep(SUBMIT_RETRY_BACKOFF_MS);
  }
  throw new HerdrError(
    "agent_prompt_stalled",
    `agent prompt to '${target}' was not accepted after ${SUBMIT_MAX_ATTEMPTS} attempts — agent never left idle (interactive_ready can be premature)`,
  );
}

async function closePane(c: StepCtx, placed: PlacedPane): Promise<void> {
  await c.opts.deps.paneClose(placed.pane_id).catch(() => undefined);
}

async function placeNewAgentPane(
  c: StepCtx,
  action: AgentAction,
): Promise<{ name: string; placed: PlacedPane }> {
  const pane = action.pane ?? { open: "tab" as const };
  const sub = (text?: string) => (text === undefined ? undefined : substituteText(text, c.values));
  const placed = await placeEmptyPane({
    open: resolvePaneOpen(pane.open, c.values),
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
  return {
    name: generateAgentName(c.step.id, c.stepIndex, c.opts.runId),
    placed,
  };
}

async function bootNewAgent(
  deps: RunnerDeps,
  name: string,
  profile: AgentProfile,
  placed: PlacedPane,
): Promise<void> {
  await startAgentWhenShellReady(deps, {
    name,
    kind: profile.kind,
    pane_id: placed.pane_id,
    args: profile.args ?? [],
  });
  await awaitAgentInteractiveReady(deps, name);
}

async function newAgentTurn(c: StepCtx, action: AgentAction): Promise<StepOutcome> {
  const chosen = await chooseProfile(c, action);
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
    placement = await placeNewAgentPane(c, action);
    await bootNewAgent(c.opts.deps, placement.name, chosen.profile, placement.placed);
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
