import { HerdrError, herdrCall, herdrCli } from "./rpc";

export { HerdrError, herdrCall, herdrRequest } from "./rpc";

export async function tabClose(tabId: string): Promise<void> {
  await herdrCall("tab.close", { tab_id: tabId });
}

export type LayoutApplyResult = { tabId: string; paneId: string; workspaceId: string };

export async function layoutApply(params: {
  workspaceId?: string;
  tabLabel: string;
  tabId?: string;
  cwd: string;
  command: string[];
  label: string;
  env?: Record<string, string>;
  focus?: boolean;
}): Promise<LayoutApplyResult> {
  // herdr rejects both set ("use either tab_id or workspace_id, not both").
  const result = await herdrCall("layout.apply", {
    workspace_id: params.tabId ? null : (params.workspaceId ?? null),
    tab_label: params.tabLabel,
    tab_id: params.tabId ?? null,
    focus: params.focus ?? true,
    root: {
      type: "pane",
      label: params.label,
      cwd: params.cwd,
      command: params.command,
      env: params.env ?? {},
    },
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
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID ?? "herdr-workflows",
    "--entrypoint",
    params.entrypoint,
  ];
  if (params.placement) args.push("--placement", params.placement);
  for (const [key, value] of Object.entries(params.env ?? {}))
    args.push("--env", `${key}=${value}`);
  const { stderr, exitCode, stdout } = await herdrCli(args);
  if (exitCode !== 0) {
    const body = stderr.trim() || stdout.trim();
    if (body.includes("ui_busy")) throw new HerdrError("ui_busy", body);
    throw new HerdrError("plugin_pane_open_failed", body || "plugin pane open failed");
  }
}

export async function paneRead(
  paneId: string,
  opts: { source?: "visible" | "recent" | "recent-unwrapped"; lines?: number } = {},
): Promise<string> {
  const args = ["pane", "read", paneId, "--format", "text"];
  if (opts.source) args.push("--source", opts.source);
  if (opts.lines !== undefined) args.push("--lines", String(opts.lines));
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
  const { stdout, stderr, exitCode } = await herdrCli([
    "wait",
    "output",
    paneId,
    "--match",
    match,
    "--regex",
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
