import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertUnderCaptureCap,
  AGENT_PROMPT_BYTE_LIMIT,
  CAPTURE_BYTE_LIMIT,
  CaptureLimitError,
} from "../caps";
import {
  configPathsHint,
  globalConfigPath,
  repoConfigPath,
  resolveProfile,
  type AgentProfile,
} from "../context";
import { HerdrError } from "../host";
import { substituteText } from "../workflow/grammar";
import type { StepAction } from "../workflow/grammar";
import {
  parseVerdict,
  verdictMismatchMessage,
  verdictNotRequiredMessage,
  type AgentResult,
  type ExpectSpec,
  type StepFailureDetails,
} from "../workflow/results";
import {
  dispatchFailure,
  ensureRunScratchDir,
  runScratchDir,
  type RunnerDeps,
  type StepFrame,
  type StepOutcome,
} from "./contract";
import {
  placeEmptyPane,
  quotePosixArg,
  resolvePaneLabel,
  resolvePaneOpen,
  type PlacedPane,
} from "./pane";

const AGENT_NAME_MAX = 32;

function normalizedPrefix(raw: string): string {
  const lowered = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "");
  return lowered || "agent";
}

export function generateAgentName(
  stepId: string | undefined,
  ordinal: number,
  suffix: string,
): string {
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "") || "0";
  const prefix = normalizedPrefix(stepId ?? `step-${ordinal}`);
  const room = Math.max(1, AGENT_NAME_MAX - tail.length - 1);
  return `${prefix.slice(0, room)}-${tail}`.slice(0, AGENT_NAME_MAX);
}

function managedResponsePath(runId: string, stepIndex: number, responseDir: string): string {
  return join(responseDir, `${runId}-step-${stepIndex}.txt`);
}

/** Spill path for agent.prompt bodies that exceed AGENT_PROMPT_BYTE_LIMIT. */
function managedPromptSpillPath(runId: string, stepIndex: number, responseDir: string): string {
  return join(responseDir, `${runId}-step-${stepIndex}-prompt.txt`);
}

function appendResponseInstruction(prompt: string, path: string, expect?: ExpectSpec): string {
  const base = `${prompt}\n\nRequired: use your file-write tool to write your full answer as plain UTF-8 text to the absolute path ${path}, overwriting whatever is there. Do not finish until that file exists with your answer. Write nothing else to that path and do not create other files for it. Printing the answer in chat is not enough.`;
  if (!expect) return base;
  const tokens = expect.oneOf.join(", ");
  const check = `hwf response check ${quotePosixArg(path)} --one-of ${expect.oneOf.join(",")}`;
  return `${base}\n\nRequired verdict: the final non-empty line of that file must be exactly one of these tokens and nothing else: ${tokens}. Put your reasoning above it. Before you finish the turn, run \`${check}\` and correct the file until that command exits 0.`;
}

function spilledPromptInstruction(spillPath: string): string {
  return `Read the absolute path ${spillPath} as UTF-8 and follow its instructions exactly. Do not invent content beyond that file.`;
}

export async function readManagedResponse(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError(
      "managed_response_missing",
      `managed response file was not written: ${path}`,
    );
  }
  const size = file.size;
  if (size > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError("managed response", size);
  const text = await file.text();
  assertUnderCaptureCap("managed response", text);
  if (!text.trim()) {
    throw new HerdrError("managed_response_empty", `managed response file is empty: ${path}`);
  }
  return text;
}

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
 * Wait this long after each agent.prompt for acceptance evidence.
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

async function chooseProfile(frame: StepFrame, action: AgentAction): Promise<ProfileChoice> {
  const name =
    action.using !== undefined
      ? substituteText(action.using, frame.values)
      : frame.opts.config.default_profile;
  if (!name) {
    const hint = configPathsHint(await globalConfigPath(), repoConfigPath(frame.opts.repoRoot));
    return {
      ok: false,
      error: `agent: no using: profile and no default_profile is configured (${hint}); run \`hwf init\` or \`hwf init --global\``,
    };
  }
  const profile = resolveProfile(frame.opts.config, name);
  if (!profile) return { ok: false, error: `agent: unknown profile '${name}'` };
  return { ok: true, name, profile };
}

function responseDirOf(frame: StepFrame): string {
  return frame.opts.deps.responseDir ?? runScratchDir(frame.opts.repoRoot);
}

async function preparedResponsePath(frame: StepFrame): Promise<string> {
  const path = managedResponsePath(frame.opts.runId, frame.stepIndex, responseDirOf(frame));
  await ensureRunScratchDir(frame.opts.repoRoot, dirname(path));
  // Child workflows reuse the parent runId with step indexes restarting at 0, so a
  // leftover file at this path could pass for this turn's pickup and response.
  await rm(path, { force: true });
  frame.opts.managedResponseFiles.push(path);
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

type TurnWait = { settled: true } | { settled: false; error: string };

async function awaitManagedTurn(
  frame: StepFrame,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
): Promise<TurnWait> {
  const deps = frame.opts.deps;
  const deadline = deps.now() + timeoutMs;
  let notifiedBlocked = false;
  let sawActive = false;
  let settledEmptyPolls = 0;
  for (;;) {
    const status = await deps.agentStatus(target);
    const hasText = await fileHasText(path);
    if (SETTLED.has(status) && hasText) return { settled: true };
    if (!SETTLED.has(status)) sawActive = true;

    // Skip pre-work idle: agent.start leaves the agent idle until the prompt is taken.
    const emptySettled =
      mode === "new-agent" && SETTLED.has(status) && !hasText && (status === "done" || sawActive);
    if (emptySettled) {
      settledEmptyPolls += 1;
      // A paste stall can slip past submit-time pickup checks when detection flickers off idle.
      if (settledEmptyPolls === 1) {
        await deps.herdrCall("agent.send_keys", { target, keys: ["enter"] }).catch(() => undefined);
      }
      if (settledEmptyPolls > SETTLED_EMPTY_GRACE_POLLS) {
        return { settled: false, error: await missingManagedError(path) };
      }
    } else {
      settledEmptyPolls = 0;
    }

    if (status !== "blocked") notifiedBlocked = false;
    else if (!notifiedBlocked) {
      notifiedBlocked = true;
      await deps
        .notificationShow(
          `herdr-workflows: ${frame.opts.name} agent blocked`,
          `${target} is waiting for input at step ${frame.stepIndex}`,
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

/** Settle-time gate: authoritative even when the agent skipped the `hwf response check` self-check. */
function applyVerdict(
  response: string,
  expect: ExpectSpec,
  details: Record<string, unknown>,
): { ok: true; verdict: string } | Extract<StepOutcome, { ok: false }> {
  const parsed = parseVerdict(response, expect.oneOf);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `agent: ${verdictMismatchMessage(parsed.line, expect.oneOf)}`,
      details,
    };
  }
  if (expect.require && !expect.require.includes(parsed.verdict)) {
    const failure: StepFailureDetails = { verdict: parsed.verdict };
    return {
      ok: false,
      error: `agent: ${verdictNotRequiredMessage(parsed.verdict, expect.require)}`,
      details: { ...details, ...failure },
    };
  }
  return { ok: true, verdict: parsed.verdict };
}

async function managedResult(
  frame: StepFrame,
  target: string,
  path: string,
  timeoutMs: number,
  mode: ManagedWaitMode,
  details: Record<string, unknown>,
  expect?: ExpectSpec,
): Promise<StepOutcome> {
  const wait = await awaitManagedTurn(frame, target, path, timeoutMs, mode);
  if (!wait.settled) {
    return { ok: false, error: wait.error, details };
  }
  let response: string;
  let agent: Record<string, unknown>;
  try {
    response = await readManagedResponse(path);
    agent = await frame.opts.deps.agentInfo(target);
  } catch (error) {
    const message =
      error instanceof HerdrError ? error.message : `managed response: ${String(error)}`;
    return { ok: false, error: message, details };
  }
  const pane =
    typeof details.pane_id === "string"
      ? details.pane_id
      : typeof agent.pane_id === "string"
        ? agent.pane_id
        : "";
  const result: AgentResult = { response, agent, pane_id: pane };
  if (!expect) return { ok: true, result };
  const gate = applyVerdict(response, expect, details);
  if (!gate.ok) return gate;
  return { ok: true, result: { ...result, verdict: gate.verdict } };
}

/**
 * Positive evidence the prompt was consumed: the agent is visibly working or
 * blocked, or (managed turns) the response file exists. `done` is the same
 * underlying ready state as `idle` — herdr flips a never-focused fresh tab
 * idle→done from focus bookkeeping alone, so settling there proves nothing.
 */
async function promptAccepted(
  deps: RunnerDeps,
  target: string,
  responsePath?: string,
): Promise<boolean> {
  const status = await deps.agentStatus(target);
  if (status === "working" || status === "blocked") return true;
  return responsePath !== undefined && (await fileHasText(responsePath));
}

async function waitForPromptPickup(
  deps: RunnerDeps,
  target: string,
  deadlineMs: number,
  responsePath?: string,
): Promise<boolean> {
  const deadline = deps.now() + deadlineMs;
  while (deps.now() < deadline) {
    if (await promptAccepted(deps, target, responsePath)) return true;
    await deps.sleep(SUBMIT_PICKUP_POLL_MS);
  }
  return promptAccepted(deps, target, responsePath);
}

/** Spill oversized bodies so agent.prompt does not silently drop them. */
async function maybeSpillAgentPrompt(frame: StepFrame, text: string): Promise<string> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= AGENT_PROMPT_BYTE_LIMIT) return text;
  assertUnderCaptureCap("agent prompt", text);
  const spill = managedPromptSpillPath(frame.opts.runId, frame.stepIndex, responseDirOf(frame));
  await ensureRunScratchDir(frame.opts.repoRoot, dirname(spill));
  await writeFile(spill, text, { mode: 0o600 });
  frame.opts.managedResponseFiles.push(spill);
  return spilledPromptInstruction(spill);
}

/**
 * Submit until acceptance is proven, re-sending the full prompt when a cold agent drops it.
 * Enter nudge only handles the separate bracketed-paste case (text present, not submitted).
 */
async function submitPrompt(
  frame: StepFrame,
  target: string,
  text: string,
  responsePath?: string,
): Promise<void> {
  const deps = frame.opts.deps;
  const body = await maybeSpillAgentPrompt(frame, text);
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    // A slow-but-successful earlier submit may land during backoff — never double-prompt.
    if (attempt > 1 && (await promptAccepted(deps, target, responsePath))) return;
    await deps.herdrCall("agent.prompt", { target, text: body });
    if (await waitForPromptPickup(deps, target, SUBMIT_PICKUP_DEADLINE_MS, responsePath)) return;
    // Paste stall: text may be in the composer without an Enter. Never re-prompt if this wakes it.
    await deps.herdrCall("agent.send_keys", { target, keys: ["enter"] });
    if (await waitForPromptPickup(deps, target, SUBMIT_ENTER_FOLLOWUP_MS, responsePath)) return;
    if (attempt < SUBMIT_MAX_ATTEMPTS) await deps.sleep(SUBMIT_RETRY_BACKOFF_MS);
  }
  throw new HerdrError(
    "agent_prompt_stalled",
    `agent prompt to '${target}' was not accepted after ${SUBMIT_MAX_ATTEMPTS} attempts — agent never showed working or blocked (a cold agent CLI can drop input typed before it listens)`,
  );
}

async function closePane(frame: StepFrame, placed: PlacedPane): Promise<void> {
  await frame.opts.deps.paneClose(placed.pane_id).catch(() => undefined);
}

async function placeNewAgentPane(
  frame: StepFrame,
  action: AgentAction,
): Promise<{ name: string; placed: PlacedPane }> {
  const pane = action.pane ?? { open: "tab" as const };
  const sub = (text?: string) =>
    text === undefined ? undefined : substituteText(text, frame.values);
  const placed = await placeEmptyPane({
    open: resolvePaneOpen(pane.open, frame.values),
    anchor: sub(pane.anchor),
    workspace: sub(pane.workspace),
    size: pane.size,
    focus: pane.focus ?? action.background !== true,
    cwd: action.cwd !== undefined ? substituteText(action.cwd, frame.values) : frame.opts.ctx.cwd,
    env: Object.fromEntries(
      Object.entries(action.env ?? {}).map(([k, v]) => [k, substituteText(v, frame.values)]),
    ),
    label: resolvePaneLabel(pane.name, frame.values, frame.step.id ?? "hwf-agent"),
    deps: frame.opts.deps,
    invocation: frame.opts.ctx,
  });
  return {
    name: generateAgentName(frame.step.id, frame.stepIndex, frame.opts.runId),
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

async function newAgentTurn(frame: StepFrame, action: AgentAction): Promise<StepOutcome> {
  const chosen = await chooseProfile(frame, action);
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
    placement = await placeNewAgentPane(frame, action);
    await bootNewAgent(frame.opts.deps, placement.name, chosen.profile, placement.placed);
    const prompt = substituteText(action.prompt, frame.values);
    if (action.background === true) {
      await submitPrompt(frame, placement.name, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(frame);
    await submitPrompt(
      frame,
      placement.name,
      appendResponseInstruction(prompt, path, action.expect),
      path,
    );
    const outcome = await managedResult(
      frame,
      placement.name,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      "new-agent",
      baseDetails(),
      action.expect,
    );
    if (outcome.ok && close === "success") await closePane(frame, placement.placed);
    return outcome;
  } catch (error) {
    const failure = dispatchFailure(`agent (profile ${chosen.name})`, error);
    return failure.ok ? failure : { ...failure, details: baseDetails() };
  } finally {
    if (close === "always" && placement) await closePane(frame, placement.placed);
  }
}

async function targetTurn(
  frame: StepFrame,
  action: AgentAction,
  rawTarget: string,
): Promise<StepOutcome> {
  const target = substituteText(rawTarget, frame.values);
  if (!target) return { ok: false, error: "agent: target resolved to an empty value" };
  const details = agentDetails({ target });
  try {
    const status = await frame.opts.deps.agentStatus(target);
    if (!SETTLED.has(status)) {
      return {
        ok: false,
        error: `agent target '${target}' is ${status} — herdr cannot correlate a queued turn; use 'herdr: agent.prompt' to queue work deliberately`,
        details: agentDetails({ target, status }),
      };
    }
    const prompt = substituteText(action.prompt, frame.values);
    if (action.background === true) {
      await submitPrompt(frame, target, prompt);
      return { ok: true, launched: true };
    }
    const path = await preparedResponsePath(frame);
    await submitPrompt(frame, target, appendResponseInstruction(prompt, path, action.expect), path);
    return await managedResult(
      frame,
      target,
      path,
      action.timeoutMs ?? TURN_TIMEOUT_MS,
      "target",
      details,
      action.expect,
    );
  } catch (error) {
    const failure = dispatchFailure(`agent (target ${target})`, error);
    return failure.ok ? failure : { ...failure, details };
  }
}

export async function agentStep(frame: StepFrame): Promise<StepOutcome> {
  const action = frame.step.action;
  if (action.kind !== "agent") return { ok: false, error: "internal: not an agent step" };
  if (action.target !== undefined) return targetTurn(frame, action, action.target);
  return newAgentTurn(frame, action);
}
