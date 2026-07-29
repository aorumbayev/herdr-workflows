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

function bin(): string {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

function socketPath(): string {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) throw new HerdrError("no_socket", "HERDR_SOCKET_PATH is not set");
  return path;
}

function transportFailure(method: string, address: string, reason: string): HerdrError {
  return new HerdrError("unreachable", `unreachable herdr at ${address}: ${method}: ${reason}`);
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
  const address = socketPath();
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
        reject(transportFailure(method, address, `timed out after ${RPC_TIMEOUT_MS}ms`)),
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
        settle(() => reject(error));
      }
    });
    sock.on("close", () => {
      settle(() => reject(transportFailure(method, address, "socket closed before response")));
    });
    sock.on("error", (error) =>
      settle(() => reject(transportFailure(method, address, error.message))),
    );
  });
}

export async function herdrCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await herdrRequest(method, params);
  if (response.error) throw new HerdrError(response.error.code, response.error.message);
  if (!response.result) throw new HerdrError("empty_result", `no result for ${method}`);
  return response.result;
}

async function herdrCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([bin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

type U8Reader = ReadableStreamDefaultReader<Uint8Array>;

let reader: U8Reader | undefined;
let stdinBuf = "";
const decoder = new TextDecoder();

export type PromptResult = { kind: "line"; text: string } | { kind: "cancel" };

function hasBareEsc(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0x1b) continue;
    const next = raw[i + 1];
    if (next !== "[" && next !== "O") return true;
  }
  return false;
}

/** herdr prefix leaks into popup stdin — strip C0 controls (keep tab/CR/LF/ESC). */
function sanitizePromptInput(raw: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional C0 strip for leaked herdr prefix keys
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");
}

/** Strip C0 controls from AI/evidence text before writing to the terminal (keep tab/CR/LF). */
export function sanitizeDisplay(raw: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional C0 strip before terminal write
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function interpretLine(raw: string): PromptResult {
  if (hasBareEsc(raw)) return { kind: "cancel" };
  const text = sanitizePromptInput(raw).replace(/\r$/, "").trim();
  return { kind: "line", text };
}

export async function readLine(): Promise<PromptResult> {
  // Bun's getReader() typings omit readMany; cast keeps a single shared stdin reader.
  if (!reader) reader = Bun.stdin.stream().getReader() as unknown as U8Reader;
  const r = reader;
  while (true) {
    const nl = stdinBuf.indexOf("\n");
    if (nl !== -1) {
      const line = stdinBuf.slice(0, nl);
      stdinBuf = stdinBuf.slice(nl + 1);
      return interpretLine(line);
    }
    const { done, value } = await r.read();
    if (done) {
      const rest = stdinBuf;
      stdinBuf = "";
      if (!rest) return { kind: "cancel" };
      return interpretLine(rest);
    }
    stdinBuf += decoder.decode(value, { stream: true });
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
