import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillAgentArgv } from "../../config";
import {
  HerdrError,
  PANE_READ_LINES,
  PANE_READ_SOURCE,
  placeCommand,
  type PlaceOpts,
} from "../../herdr";
import type { FlatStep, PlaceholderValues } from "../../workflow/types";
import { AGENT_NAME_RE, substitute } from "../../workflow/parse";
import { substituteEnv } from "./shell";

const AGENT_WAIT_POLL_MS = 2000;
const AGENT_WAIT_IDLE_GRACE_MS = 30_000;
const AGENT_OUTPUT_INSTRUCTION = `Write your final response, and nothing else, to this exact absolute path, overwriting it:
{path}
Do not print the response in the terminal.`;

type WaitAgentDoneOpts = {
  agentStatus: (paneId: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  idleGraceMs?: number;
  onBlocked?: () => Promise<void>;
};

async function waitAgentDone(
  paneId: string,
  timeoutMs: number,
  opts: WaitAgentDoneOpts,
): Promise<void> {
  const sleep = opts.sleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? AGENT_WAIT_POLL_MS;
  const idleGraceMs = opts.idleGraceMs ?? AGENT_WAIT_IDLE_GRACE_MS;
  const start = now();
  let sawWorking = false;
  let everResolved = false;
  let consecutiveErrors = 0;
  let blockedNotified = false;

  while (true) {
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      throw new Error(`agent wait timed out after ${Math.round(timeoutMs / 1000)}s`);
    }

    try {
      const status = await opts.agentStatus(paneId);
      everResolved = true;
      consecutiveErrors = 0;

      if (status === "done") return;

      if (status === "working") {
        sawWorking = true;
        blockedNotified = false;
      } else if (status === "idle") {
        if (sawWorking) return;
        if (elapsed >= idleGraceMs) return;
      } else if (status === "blocked") {
        if (!blockedNotified) {
          blockedNotified = true;
          await opts.onBlocked?.();
        }
      }
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      consecutiveErrors += 1;
      // Before the first successful read, errors usually mean herdr hasn't detected the
      // freshly spawned agent yet — tolerate them for the grace window instead of 3 strikes.
      if (everResolved ? consecutiveErrors >= 3 : elapsed >= idleGraceMs) throw error;
    }

    await sleep(pollMs);
  }
}

const INVOKING_AGENT = "{agent}";

function resolveAgentName(stepName: string, values: PlaceholderValues): string {
  if (stepName === INVOKING_AGENT) return values.agent ?? "";
  const m = AGENT_NAME_RE.exec(stepName);
  return m ? (values[m[1]!] ?? "") : stepName;
}

type AgentStepCtx = {
  step: FlatStep;
  values: PlaceholderValues;
  opts: PlaceOpts & {
    name: string;
    agents: Record<string, string[]>;
    ctx: PlaceOpts["ctx"] & { cwd: string };
    deps: PlaceOpts["deps"] & {
      agentStatus: (paneId: string) => Promise<string>;
      waitOutput: (paneId: string, pattern: string, timeoutMs: number) => Promise<unknown>;
      paneRead: (paneId: string, opts: { source: string; lines: number }) => Promise<string>;
      paneClose: (paneId: string) => Promise<unknown>;
      tabClose: (tabId: string) => Promise<unknown>;
      notificationShow: (title: string, body?: string) => Promise<unknown>;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      agentWaitPollMs?: number;
      agentWaitIdleGraceMs?: number;
    };
  };
  index: number;
};

export async function agentStep(
  c: AgentStepCtx,
): Promise<{ ok: true; bindings?: Record<string, string> } | { ok: false; error: string }> {
  const step = c.step as FlatStep & { action: { kind: "agent" } };
  const name = resolveAgentName(step.action.agent, c.values);
  if (step.action.agent === INVOKING_AGENT && !name) {
    return { ok: false, error: "invoking agent unresolved — run from agent pane" };
  }
  const template = c.opts.agents[name];
  if (!template) {
    return { ok: false, error: `unknown agent '${name}'` };
  }
  let prompt = step.action.prompt !== undefined ? substitute(step.action.prompt, c.values) : "";
  const outputDir =
    step.out?.kind === "text" ? await mkdtemp(join(tmpdir(), "hwf-agent-")) : undefined;
  const outputPath = outputDir ? join(outputDir, "output.txt") : undefined;
  if (outputPath) {
    prompt = `${prompt}\n\n${AGENT_OUTPUT_INSTRUCTION.replace("{path}", outputPath)}`;
  }
  const cwd =
    step.action.cwd !== undefined ? substitute(step.action.cwd, c.values) : c.opts.ctx.cwd;
  const stepEnv = substituteEnv(step.action.env, c.values);
  const target = step.action.in === "here" ? "tab" : step.action.in;
  try {
    const spawned = await placeCommand(
      c.opts,
      target,
      fillAgentArgv(template, prompt),
      name,
      cwd,
      stepEnv,
      step.action.ratio,
      step.action.focus,
    );

    if (step.wait.kind === "detach") return { ok: true };

    try {
      const timeoutMs = step.timeoutMs ?? 1_800_000;
      if (step.wait.kind === "regex") {
        await c.opts.deps.waitOutput(spawned.paneId, step.wait.pattern, timeoutMs);
      } else {
        await waitAgentDone(spawned.paneId, timeoutMs, {
          agentStatus: c.opts.deps.agentStatus,
          sleep: c.opts.deps.sleep ?? ((ms) => Bun.sleep(ms)),
          now: c.opts.deps.now,
          pollMs: c.opts.deps.agentWaitPollMs,
          idleGraceMs: c.opts.deps.agentWaitIdleGraceMs,
          onBlocked: async () => {
            await c.opts.deps.notificationShow(
              `herdr-workflows: ${c.opts.name} waiting`,
              `agent blocked on step ${c.index} — needs your input`,
            );
          },
        });
      }
      if (outputPath && step.out?.kind === "text") {
        const text = await readFile(outputPath, "utf8").catch(() => "");
        if (text.length === 0) {
          return {
            ok: false,
            error: `agent did not write output '${step.out.name}'`,
          };
        }
        return { ok: true, bindings: { [step.out.name]: text } };
      }
      await c.opts.deps.paneRead(spawned.paneId, {
        source: PANE_READ_SOURCE,
        lines: PANE_READ_LINES,
      });
      return { ok: true };
    } finally {
      // close: reaps the spent pane on success and failure alike — out:/error are already captured.
      if (step.action.close) {
        await c.opts.deps.paneClose(spawned.paneId).catch(() => undefined);
        if (target === "tab") await c.opts.deps.tabClose(spawned.tabId).catch(() => undefined);
      }
    }
  } finally {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
