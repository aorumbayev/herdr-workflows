import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { checkHerdrProtocol } from "./herdr-methods";
import type { PaneOpen } from "./workflow/types";

type Placement = "here" | PaneOpen | "right" | "down" | "beside" | "below";

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

const RPC_TIMEOUT_MS = 10_000;

// Raw socket request. Prefer CLI wrappers when they exist; socket-only for layout.apply (no CLI
// surface) and plugin.pane.open (picker hot path — a CLI subprocess costs ~50ms per launch).
export function herdrRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<HerdrResponse> {
  const id = `herdr-workflows:${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify({ id, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath());
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
        reject(new HerdrError("timeout", `${method} timed out after ${RPC_TIMEOUT_MS}ms`)),
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
      settle(() => reject(new HerdrError("closed", `${method}: socket closed before response`)));
    });
    sock.on("error", (error) => settle(() => reject(error)));
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

/** Request ceiling for pane scrollback. Actual text still capped by herdr retention. */
const PANE_READ_LINES = 100_000;
const PANE_READ_SOURCE = "recent-unwrapped" as const;

export async function tabClose(tabId: string): Promise<void> {
  await herdrCall("tab.close", { tab_id: tabId });
}

export async function paneClose(paneId: string): Promise<void> {
  await herdrCall("pane.close", { pane_id: paneId });
}

export type LayoutApplyResult = { tabId: string; paneId: string; workspaceId: string };

type LayoutPaneNode = {
  type: "pane";
  label?: string;
  cwd?: string;
  command?: string[];
  env?: Record<string, string>;
  pane_id?: string;
};

type LayoutSplitNode = {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
};

export type LayoutNode = LayoutPaneNode | LayoutSplitNode;

export async function layoutApply(params: {
  workspaceId?: string;
  tabLabel?: string;
  tabId?: string;
  root: LayoutNode;
  focus?: boolean;
}): Promise<LayoutApplyResult> {
  // herdr rejects both set ("use either tab_id or workspace_id, not both").
  const result = await herdrCall("layout.apply", {
    workspace_id: params.tabId ? null : (params.workspaceId ?? null),
    tab_label: params.tabLabel ?? null,
    tab_id: params.tabId ?? null,
    focus: params.focus ?? true,
    root: params.root,
  });
  const layout = result.layout as
    | { tab_id?: string; focused_pane_id?: string; workspace_id?: string }
    | undefined;
  const tabId = layout?.tab_id;
  const paneId = layout?.focused_pane_id;
  const workspaceId = layout?.workspace_id ?? params.workspaceId;
  if (!tabId || !paneId || !workspaceId)
    throw new HerdrError("layout_apply_failed", "layout.apply missing tab/pane ids");
  return { tabId, paneId, workspaceId };
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

export async function paneRead(
  paneId: string,
  opts: {
    source?: "visible" | "recent" | "recent-unwrapped";
    lines?: number;
  } = {},
): Promise<string> {
  const args = [
    "pane",
    "read",
    paneId,
    "--format",
    "text",
    "--source",
    opts.source ?? PANE_READ_SOURCE,
    "--lines",
    String(opts.lines ?? PANE_READ_LINES),
  ];
  const { stdout, stderr, exitCode } = await herdrCli(args);
  if (exitCode !== 0) throw new HerdrError("pane_read_failed", stderr.trim() || "pane read failed");
  return stdout;
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
      agent_session?: { value?: unknown };
      cwd?: unknown;
    };
  };
};

async function agentGet(paneId: string): Promise<NonNullable<AgentGetJson["result"]>["agent"]> {
  const { stdout, stderr, exitCode } = await herdrCli(["agent", "get", paneId]);
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

export async function agentStatus(paneId: string): Promise<string> {
  const agent = await agentGet(paneId);
  const status = agent?.agent_status;
  if (typeof status !== "string") {
    throw new HerdrError("agent_status_failed", "agent get missing agent_status");
  }
  return status;
}

export type AgentSessionInfo = { agent: string; sessionId: string; cwd: string };

export async function agentLabel(paneId: string): Promise<string> {
  const info = await agentGet(paneId);
  if (typeof info?.agent !== "string" || !info.agent) {
    throw new HerdrError("no_agent", "no agent detected in this pane");
  }
  return info.agent;
}

export async function agentSessionInfo(paneId: string): Promise<AgentSessionInfo> {
  const info = await agentGet(paneId);
  const agent = info?.agent;
  const sessionId = info?.agent_session?.value;
  const cwd = info?.cwd;
  if (typeof agent !== "string" || typeof sessionId !== "string" || typeof cwd !== "string") {
    throw new HerdrError("no_agent_session", "no agent session detected in this pane");
  }
  return { agent, sessionId, cwd };
}

export async function waitOutput(paneId: string, match: string, timeoutMs: number): Promise<void> {
  // herdr 0.7.5 removed top-level `wait`; `pane wait-output` takes the pane id first and the
  // pattern as --regex's value — passing --regex before the pane id makes herdr reject it.
  const { stdout, stderr, exitCode } = await herdrCli([
    "pane",
    "wait-output",
    paneId,
    "--regex",
    match,
    "--timeout",
    String(timeoutMs),
  ]);
  if (exitCode !== 0) {
    throw new HerdrError(
      "wait_output_failed",
      stderr.trim() || stdout.trim() || "wait output failed",
    );
  }
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
  const check = checkHerdrProtocol(result.protocol);
  if (!check.ok) throw new HerdrError("protocol_mismatch", check.error);
  checked = true;
}

type PlaceLayoutApply = (params: {
  workspaceId?: string;
  tabId?: string;
  tabLabel?: string;
  root: unknown;
  focus?: boolean;
}) => Promise<{ tabId: string; paneId: string; workspaceId: string }>;

type PlaceOpts = {
  deps: { layoutApply: PlaceLayoutApply };
  ctx: {
    workspaceId?: string;
    paneId?: string;
    tabId?: string;
  };
};

export async function placeCommand(
  opts: PlaceOpts,
  place: Placement,
  argv: string[],
  label: string,
  cwd: string,
  env: Record<string, string> | undefined,
  ratio: number | undefined,
  focus?: boolean,
): Promise<{ tabId: string; paneId: string; workspaceId: string }> {
  if (place === "tab") {
    return opts.deps.layoutApply({
      workspaceId: opts.ctx.workspaceId,
      tabLabel: label,
      root: {
        type: "pane",
        label,
        cwd,
        command: argv,
        env: env ?? {},
      },
      focus: focus ?? true,
    });
  }
  if (place === "right" || place === "down" || place === "beside" || place === "below") {
    if (!opts.ctx.paneId || !opts.ctx.tabId) {
      throw new HerdrError("placement_failed", `in: ${place} requires an invoking pane`);
    }
    const direction =
      place === "beside" || place === "right"
        ? "right"
        : place === "below" || place === "down"
          ? "down"
          : place;
    return opts.deps.layoutApply({
      tabId: opts.ctx.tabId,
      root: {
        type: "split",
        direction,
        ratio: ratio ?? 0.5,
        first: { type: "pane", pane_id: opts.ctx.paneId },
        second: {
          type: "pane",
          label,
          cwd,
          command: argv,
          env: env ?? {},
        },
      },
      focus: focus ?? true,
    });
  }
  throw new HerdrError("placement_failed", "in: here does not place a pane");
}
