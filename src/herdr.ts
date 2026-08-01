import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { checkHerdrStartup } from "./herdr-methods";

export type HerdrResponse = {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function herdrBinPath(): string {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

function socketPath(): string {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) throw new HerdrError("no_socket", "HERDR_SOCKET_PATH is not set");
  return path;
}

/** Transport-loss codes the runner treats as uncertain coordination. */
export const TRANSPORT_LOSS_CODES = ["closed", "no_socket", "unreachable"] as const;

function unreachableFailure(method: string, address: string, reason: string): HerdrError {
  return new HerdrError("unreachable", `unreachable herdr at ${address}: ${method}: ${reason}`);
}

function closedFailure(method: string): HerdrError {
  return new HerdrError("closed", `${method}: socket closed before response`);
}

const RPC_TIMEOUT_MS = 10_000;

// Raw socket request. Prefer CLI wrappers when they exist; socket-only for layout.apply (no CLI
// surface) and plugin.pane.open (picker hot path — a CLI subprocess costs ~50ms per launch).
export function herdrRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<HerdrResponse> {
  const id = `herdr-workflows:${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify({ id, method, params })}\n`;
  let address: string;
  try {
    address = socketPath();
  } catch (error) {
    return Promise.reject(asHerdrError(error, "no_socket", "HERDR_SOCKET_PATH is not set"));
  }
  return new Promise((resolve, reject) => {
    const sock = connect(address);
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      sock.destroy();
      settle(() =>
        reject(unreachableFailure(method, address, `timed out after ${RPC_TIMEOUT_MS}ms`)),
      );
    }, RPC_TIMEOUT_MS);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      sock.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as HerdrResponse;
        settle(() => resolve(parsed));
      } catch (error) {
        settle(() =>
          reject(asHerdrError(error, "invalid_response", `invalid JSON from herdr for ${method}`)),
        );
      }
    });
    sock.on("close", () => {
      settle(() => reject(closedFailure(method)));
    });
    sock.on("error", (error) =>
      settle(() => reject(unreachableFailure(method, address, error.message))),
    );
  });
}

function asHerdrError(error: unknown, code: string, fallback: string): HerdrError {
  if (error instanceof HerdrError) return error;
  const message = error instanceof Error ? error.message : fallback;
  return new HerdrError(code, message || fallback);
}

export async function herdrCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  try {
    const response = await herdrRequest(method, params);
    if (response.error) throw new HerdrError(response.error.code, response.error.message);
    if (!response.result) throw new HerdrError("empty_result", `no result for ${method}`);
    return response.result;
  } catch (error) {
    throw asHerdrError(error, "internal", `herdr call failed: ${method}`);
  }
}

async function herdrCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn([herdrBinPath(), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    throw asHerdrError(error, "internal", `herdr CLI failed: ${args.join(" ")}`);
  }
}

export async function tabClose(tabId: string): Promise<void> {
  await herdrCall("tab.close", { tab_id: tabId });
}

export async function paneClose(paneId: string): Promise<void> {
  await herdrCall("pane.close", { pane_id: paneId });
}

export async function pluginPaneOpen(params: {
  entrypoint: string;
  env?: Record<string, string>;
  placement?: string;
}): Promise<void> {
  // Socket instead of the CLI wrapper: skips a herdr subprocess on the picker hot path.
  // focus: true matches the CLI default (`herdr plugin pane open` without --no-focus).
  await herdrCall("plugin.pane.open", {
    plugin_id: process.env.HERDR_PLUGIN_ID ?? "herdr-workflows",
    entrypoint: params.entrypoint,
    placement: params.placement ?? null,
    focus: true,
    env: params.env ?? {},
  });
}

export async function notificationShow(title: string, body?: string): Promise<void> {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  const { stdout, stderr, exitCode } = await herdrCli(args);
  if (exitCode !== 0) {
    throw new HerdrError(
      "notification_show_failed",
      stderr.trim() || stdout.trim() || "notification show failed",
    );
  }
}

type AgentGetJson = {
  result?: {
    agent?: {
      agent?: unknown;
      agent_status?: unknown;
      agent_session?: { value?: unknown; kind?: unknown };
      cwd?: unknown;
    };
  };
};

async function agentGet(target: string): Promise<NonNullable<AgentGetJson["result"]>["agent"]> {
  const { stdout, stderr, exitCode } = await herdrCli(["agent", "get", target]);
  if (exitCode !== 0) {
    throw new HerdrError("agent_status_failed", stderr.trim() || "agent get failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new HerdrError("agent_status_failed", "agent get returned invalid JSON");
  }
  return (parsed as AgentGetJson)?.result?.agent;
}

/** `target` is an agent name or a pane id — `herdr agent get` accepts either. */
export async function agentStatus(target: string): Promise<string> {
  const agent = await agentGet(target);
  const status = agent?.agent_status;
  if (typeof status !== "string") {
    throw new HerdrError("agent_status_failed", "agent get missing agent_status");
  }
  return status;
}

export type AgentSessionInfo = {
  agent: string;
  sessionId: string;
  sessionKind?: string;
  cwd: string;
};

export async function agentSessionInfo(paneId: string): Promise<AgentSessionInfo> {
  const info = await agentGet(paneId);
  const agent = info?.agent;
  if (typeof agent !== "string" || !agent) {
    throw new HerdrError("no_agent_session", "no agent session detected in this pane");
  }
  const session = info?.agent_session;
  const sessionId = typeof session?.value === "string" ? session.value : "";
  const sessionKind = typeof session?.kind === "string" ? session.kind : undefined;
  const cwd = typeof info?.cwd === "string" ? info.cwd : "";
  return {
    agent,
    sessionId,
    ...(sessionKind !== undefined ? { sessionKind } : {}),
    cwd,
  };
}

export async function reportToken(paneId: string, value: string | null): Promise<void> {
  const args =
    value === null
      ? [
          "pane",
          "report-metadata",
          paneId,
          "--source",
          "herdr-workflows",
          "--clear-token",
          "herdr-workflows",
        ]
      : [
          "pane",
          "report-metadata",
          paneId,
          "--source",
          "herdr-workflows",
          "--token",
          `herdr-workflows=${value}`,
          "--ttl-ms",
          "600000",
        ];
  const { stdout, stderr, exitCode } = await herdrCli(args);
  if (exitCode !== 0) {
    throw new HerdrError(
      "report_token_failed",
      stderr.trim() || stdout.trim() || "report token failed",
    );
  }
}

let checked = false;

/** One-shot startup check against the connected herdr. No-ops when no socket is configured. */
export async function ensureHerdrProtocol(): Promise<void> {
  if (checked) return;
  if (!process.env.HERDR_SOCKET_PATH) return;
  const result = await herdrCall("ping", {});
  const check = checkHerdrStartup({ protocol: result.protocol, version: result.version });
  if (!check.ok) throw new HerdrError("protocol_mismatch", check.error);
  checked = true;
}
