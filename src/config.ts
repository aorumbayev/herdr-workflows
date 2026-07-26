import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paneRead, PANE_READ_LINES, PANE_READ_SOURCE, sanitizeDisplay } from "./herdr";
import type { PlaceholderValues } from "./workflow/types";

export type AgentsConfig = Record<string, string[]>;
export type SessionsConfig = Record<string, string[]>;

export type WorkflowsConfig = {
  agents: AgentsConfig;
  sessions: SessionsConfig;
};

class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

const configSchema = z
  .object({
    agents: z.record(z.string(), z.array(z.string()).min(1)),
    sessions: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [name, argv] of Object.entries(cfg.agents)) {
      const slots = argv.filter((a) => a === "{prompt}");
      if (slots.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `agent '${name}' must contain exactly one "{prompt}" argv element`,
          path: ["agents", name],
        });
      }
    }
  });

function positioned(file: string, key: string | undefined, message: string): string {
  return key ? `${file}, ${key}: ${message}` : `${file}: ${message}`;
}

function formatIssue(file: string, issue: z.core.$ZodIssue): string {
  const path = issue.path;
  let key: string | undefined;
  if (path.length > 0) key = path.map(String).join(".");
  else if (issue.code === "unrecognized_keys") key = (issue as { keys: string[] }).keys.join(", ");
  return positioned(file, key, issue.message);
}

/** Validate a config YAML buffer through the same schema `loadConfig` uses. */
export function parseConfigText(file: string, text: string): WorkflowsConfig {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (error) {
    throw new ConfigLoadError(
      positioned(file, undefined, error instanceof Error ? error.message : String(error)),
    );
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  return {
    agents: result.data.agents,
    sessions: result.data.sessions ?? {},
  };
}

async function loadFile(file: string): Promise<WorkflowsConfig | undefined> {
  const f = Bun.file(file);
  if (!(await f.exists())) return undefined;
  return parseConfigText(file, await f.text());
}

export function globalConfigPath(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "config.yaml");
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, ".hwf", "config.yaml");
}

/** Merge global then repo; repo wins per name for agents and sessions independently. */
export async function loadConfig(repoRoot: string): Promise<WorkflowsConfig> {
  const globalCfg = (await loadFile(globalConfigPath())) ?? { agents: {}, sessions: {} };
  const repoCfg = (await loadFile(repoConfigPath(repoRoot))) ?? { agents: {}, sessions: {} };
  return {
    agents: { ...globalCfg.agents, ...repoCfg.agents },
    sessions: { ...globalCfg.sessions, ...repoCfg.sessions },
  };
}

export function fillAgentArgv(template: string[], prompt: string): string[] {
  return template.map((part) => (part === "{prompt}" ? prompt : part));
}

/** Walk up from cwd looking for `.git` or `.hwf`. */
export function resolveRepoRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".hwf"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export type InvocationContext = {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  selection: string;
  cwd: string;
};

type CtxJson = {
  workspace_id?: string;
  tab_id?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  pane_id?: string;
  selected_text?: string;
  cwd?: string;
  worktree?: { path?: string };
  workspace?: { workspace_id?: string; cwd?: string };
  tab?: { tab_id?: string };
  pane?: { pane_id?: string };
};

export function readInvocationContext(): InvocationContext {
  let json: CtxJson = {};
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      json = JSON.parse(raw) as CtxJson;
    } catch {
      json = {};
    }
  }
  return {
    workspaceId:
      process.env.HERDR_WORKSPACE_ID || json.workspace_id || json.workspace?.workspace_id,
    tabId: process.env.HERDR_TAB_ID || json.tab_id || json.tab?.tab_id,
    paneId: process.env.HERDR_PANE_ID || json.focused_pane_id || json.pane_id || json.pane?.pane_id,
    selection: json.selected_text ?? "",
    cwd:
      json.worktree?.path ||
      json.focused_pane_cwd ||
      json.cwd ||
      json.workspace?.cwd ||
      process.cwd(),
  };
}

export async function buildPlaceholders(opts: {
  ctx: InvocationContext;
  prompt?: string;
  error?: string;
  session?: string;
  sessionFile?: string;
  agent?: string;
  inputs?: Record<string, string>;
}): Promise<PlaceholderValues> {
  let pane = "";
  if (opts.ctx.paneId) {
    const scrollback = await paneRead(opts.ctx.paneId, {
      source: PANE_READ_SOURCE,
      lines: PANE_READ_LINES,
    }).catch(() => "");
    pane = sanitizeDisplay(scrollback);
  }
  const values: PlaceholderValues = {
    pane,
    selection: sanitizeDisplay(opts.ctx.selection),
    prompt: opts.prompt ?? "",
    error: opts.error ?? "",
    session: opts.session ?? "",
    session_file: opts.sessionFile ?? "",
    source_tab: opts.ctx.tabId ?? "",
    agent: opts.agent ?? "",
  };
  for (const [name, value] of Object.entries(opts.inputs ?? {})) {
    values[name] = value;
  }
  return values;
}
