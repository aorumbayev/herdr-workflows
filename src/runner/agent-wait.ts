import { HerdrError } from "../adapter/client";

export const AGENT_WAIT_POLL_MS = 2000;
export const AGENT_WAIT_IDLE_GRACE_MS = 30_000;

export type WaitAgentDoneOpts = {
  agentStatus: (paneId: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  idleGraceMs?: number;
  onBlocked?: () => Promise<void>;
};

export async function waitAgentDone(
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
