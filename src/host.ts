import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  HERDR_FOCUS_POLICY,
  HERDR_METHOD_BY_NAME,
  HERDR_PROTOCOL,
  METHOD_RESULT_VARIANTS,
  MIN_HERDR_VERSION,
  RESULT_DOT_PATHS,
  type PropSpec,
} from "./herdr-methods.generated";
export { HERDR_PROTOCOL, METHOD_RESULT_VARIANTS, MIN_HERDR_VERSION, RESULT_DOT_PATHS };

const WHOLE_TEMPLATE_RE = /^\{\{\s*(?:inputs|steps|context)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+\s*\}\}$/;

type Params = Record<string, unknown>;

function present(params: Params, key: string): boolean {
  const value = params[key];
  return value !== undefined && value !== null && value !== "";
}

function explicit(method: string, detail: string): string {
  return `${method}: ${detail} — raw herdr calls never fall back to live herdr focus`;
}

function swapPolicy(method: string, params: Params): string | undefined {
  const direction = present(params, "direction") && present(params, "pane_id");
  const pair = present(params, "source_pane_id") && present(params, "target_pane_id");
  if (direction || pair) return undefined;
  return explicit(
    method,
    "needs direction with pane_id, or both source_pane_id and target_pane_id",
  );
}

function movePolicy(method: string, params: Params): string | undefined {
  const destination = params.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return `${method}: destination must be an object`;
  }
  const dest = destination as Params;
  if (dest.type === "tab" && !present(dest, "target_pane_id")) {
    return explicit(method, "destination type 'tab' needs destination.target_pane_id");
  }
  if (dest.type === "new_tab" && !present(dest, "workspace_id")) {
    return explicit(method, "destination type 'new_tab' needs destination.workspace_id");
  }
  return undefined;
}

/**
 * Explicit-target policy: omitted selectors must never reach live UI focus.
 * Classification comes from the generated schema; an unclassified method is rejected.
 */
export function assertFocusPolicy(method: string, params: Params | undefined): string | undefined {
  const obj = params ?? {};
  const policy = HERDR_FOCUS_POLICY.get(method);
  if (policy === undefined) {
    return explicit(method, "needs an explicit target selector (unclassified method)");
  }
  switch (policy.kind) {
    case "none":
    case "filter":
      return undefined;
    case "require":
      if (!present(obj, policy.field)) {
        return explicit(method, `params.${policy.field} is required`);
      }
      return undefined;
    case "exactlyOne": {
      const set = policy.fields.filter((key) => present(obj, key));
      if (set.length !== 1) {
        return explicit(method, `needs exactly one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    }
    case "atLeastOne":
      if (!policy.fields.some((key) => present(obj, key))) {
        return explicit(method, `needs one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    case "swap":
      return swapPolicy(method, obj);
    case "move":
      return movePolicy(method, obj);
  }
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(live: string, minimum: string): boolean {
  const a = parseSemver(live);
  const b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

type ParamKind = "string" | "number" | "integer" | "boolean" | "object" | "array";

function runtimeKind(value: unknown): ParamKind | "null" | "undefined" {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string" || t === "boolean" || t === "object") return t;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return "object";
}

function kindsMatch(spec: PropSpec, value: unknown): boolean {
  if (value === null) return spec.nullable;
  const kind = runtimeKind(value);
  if (kind === "null" || kind === "undefined") return false;
  if (spec.kinds.includes(kind)) return true;
  if (kind === "integer" && spec.kinds.includes("number")) return true;
  if (kind === "number" && spec.kinds.includes("integer") && Number.isInteger(value)) return true;
  return false;
}

function isWholeValueTemplateParam(value: unknown): boolean {
  return typeof value === "string" && WHOLE_TEMPLATE_RE.test(value);
}

/** Unknown / denied method, or params that violate the generated schema. */
export function validateMethodParams(
  method: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  const entry = HERDR_METHOD_BY_NAME.get(method);
  if (!entry) return `unknown herdr method '${method}'`;
  if (!entry.allowed) return `${method}: ${entry.reason}`;
  const obj = params ?? {};
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return `${method}: params must be an object`;
  }
  const { properties, required, additionalProperties } = entry.params;
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      return `${method}: missing required param '${key}'`;
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = properties[key];
    if (!prop) {
      if (!additionalProperties) return `${method}: unknown param '${key}'`;
      continue;
    }
    if (value === undefined) continue;
    // Whole-value templates keep their type until substitute; check shape at runtime.
    if (isWholeValueTemplateParam(value)) continue;
    if (prop.enumValues && !prop.enumValues.includes(value) && !(value === null && prop.nullable)) {
      return `${method}: param '${key}' must be one of ${prop.enumValues.map(String).join(", ")}`;
    }
    if (!kindsMatch(prop, value)) {
      const expect = prop.nullable ? [...prop.kinds, "null"].join("|") : prop.kinds.join("|");
      return `${method}: param '${key}' expects ${expect}`;
    }
  }
  return undefined;
}

/** Schema params then explicit-target policy — shared load-time and runtime gate. */
export function validateHerdrInvocation(
  method: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  return validateMethodParams(method, params) ?? assertFocusPolicy(method, params);
}

function pathAllowed(paths: readonly string[], fieldPath: string): boolean {
  if (paths.includes(fieldPath)) return true;
  const prefix = `${fieldPath}.`;
  return paths.some((path) => path.startsWith(prefix));
}

/** True when `fieldPath` exists on at least one success variant of `method`. */
export function isMethodResultDotPath(method: string, fieldPath: string): boolean {
  const variants = METHOD_RESULT_VARIANTS.get(method);
  if (!variants) return false;
  return variants.some((variant) => pathAllowed(variant.paths, fieldPath));
}

export type StartupCheckResult =
  | { ok: true; protocol: number; version: string }
  | { ok: false; error: string };

/** Compare live `ping` version/protocol with the pinned manifest minimum and protocol. */
export function checkHerdrStartup(live: {
  protocol: unknown;
  version: unknown;
}): StartupCheckResult {
  const protocol = live.protocol;
  const version = typeof live.version === "string" ? live.version : undefined;
  const installed = version ?? "missing";
  if (typeof protocol !== "number" || !Number.isFinite(protocol)) {
    return {
      ok: false,
      error: `herdr protocol check failed: ping did not return a protocol number (installed=${installed}, required≥${MIN_HERDR_VERSION}; protocol connected=${String(protocol)}, pinned=${HERDR_PROTOCOL})`,
    };
  }
  if (!version || !parseSemver(version)) {
    return {
      ok: false,
      error: `herdr version check failed: ping did not return a semver version (installed=${installed}, required≥${MIN_HERDR_VERSION}; protocol connected=${protocol}, pinned=${HERDR_PROTOCOL})`,
    };
  }
  if (!versionAtLeast(version, MIN_HERDR_VERSION)) {
    return {
      ok: false,
      error: `herdr version too old: installed=${version}, required≥${MIN_HERDR_VERSION}; protocol connected=${protocol}, pinned=${HERDR_PROTOCOL}`,
    };
  }
  if (protocol !== HERDR_PROTOCOL) {
    return {
      ok: false,
      error: `herdr protocol mismatch: connected=${protocol}, pinned=${HERDR_PROTOCOL} (installed=${version}, required≥${MIN_HERDR_VERSION})`,
    };
  }
  return { ok: true, protocol, version };
}

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
