import type { SessionsConfig } from "../config";
import type { InvocationContext } from "../context";
import type { LoadedWorkflow } from "../workflows/types";
import type { RunnerDeps } from "./types";

export type Preflight =
  | { ok: true; session: string; sessionFailure?: string; agent: string }
  | { ok: false; error: string };

/** Resolve {session} and {agent} preconditions; session extraction failure is non-fatal. */
export async function resolvePreflight(
  workflow: LoadedWorkflow,
  ctx: InvocationContext,
  agents: Record<string, string[]>,
  sessions: SessionsConfig,
  deps: RunnerDeps,
): Promise<Preflight> {
  let session = "";
  // Extraction failure aborts before steps and does not trigger on_error.
  let sessionFailure: string | undefined;
  if (workflow.needsSession) {
    if (!ctx.paneId) {
      return { ok: false, error: "session handoff must be launched from an agent pane" };
    }
    try {
      session = await deps.sessionText(ctx.paneId, sessions);
    } catch (err) {
      sessionFailure = err instanceof Error ? err.message : String(err);
    }
  }

  let agent = "";
  if (workflow.needsInvokingAgent) {
    if (!ctx.paneId) {
      return { ok: false, error: "invoking agent unresolved — run from agent pane" };
    }
    try {
      const label = await deps.agentLabel(ctx.paneId);
      if (!agents[label]) {
        return {
          ok: false,
          error: `invoking agent '${label}' not in config — add it under agents:`,
        };
      }
      agent = label;
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "invoking agent unresolved — run from agent pane",
      };
    }
  }
  return { ok: true, session, sessionFailure, agent };
}
