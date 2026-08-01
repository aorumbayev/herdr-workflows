import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { PlatformName, TemplateNamespace } from "./workflow/types";

export const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Strip C0 controls from AI/evidence text before writing to the terminal (keep tab/CR/LF). */
export function sanitizeDisplay(raw: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional C0 strip before terminal write
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export type AgentProfile = {
  kind: string;
  args?: string[];
};

export type TranscriptExtractor = {
  command: string[];
};

export type WorkflowsConfig = {
  profiles: Record<string, AgentProfile>;
  default_profile?: string;
  transcripts: Record<string, TranscriptExtractor>;
};

class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

const profileSchema = z
  .object({
    kind: z.string().min(1),
    args: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const transcriptSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
  })
  .strict();

const configSchema = z
  .object({
    profiles: z
      .record(
        z.string().regex(PROFILE_NAME_RE, "profile name must match [a-z][a-z0-9_-]{0,31}"),
        profileSchema,
      )
      .optional(),
    default_profile: z
      .string()
      .regex(PROFILE_NAME_RE, "default_profile must match [a-z][a-z0-9_-]{0,31}")
      .optional(),
    transcripts: z.record(z.string().min(1), transcriptSchema).optional(),
  })
  .strict();

function positioned(file: string, key: string | undefined, message: string): string {
  return key ? `${file}, ${key}: ${message}` : `${file}: ${message}`;
}

function formatIssue(file: string, issue: z.core.$ZodIssue): string {
  const unknownKeys =
    issue.code === "unrecognized_keys" ? (issue as { keys: string[] }).keys : undefined;
  const key = issue.path.length > 0 ? issue.path.map(String).join(".") : unknownKeys?.join(", ");
  const message = unknownKeys
    ? unknownKeys.map((k) => `Unrecognized key: "${k}"`).join("; ")
    : issue.message;
  return positioned(file, key ?? unknownKeys?.[0], message);
}

function emptyConfig(): WorkflowsConfig {
  return { profiles: {}, transcripts: {} };
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
  if (data === null || data === undefined) return emptyConfig();
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  return {
    profiles: result.data.profiles ?? {},
    ...(result.data.default_profile !== undefined
      ? { default_profile: result.data.default_profile }
      : {}),
    transcripts: result.data.transcripts ?? {},
  };
}

async function loadFile(file: string): Promise<WorkflowsConfig | undefined> {
  const f = Bun.file(file);
  if (!(await f.exists())) return undefined;
  return parseConfigText(file, await f.text());
}

const PLUGIN_ID = "herdr-workflows";

/** Resolve the Herdr-owned plugin config directory (never ~/.hwf). */
export async function resolvePluginConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const injected = env.HERDR_PLUGIN_CONFIG_DIR?.trim();
  if (injected) return injected;
  const bin = env.HERDR_BIN_PATH?.trim() || "herdr";
  const proc = Bun.spawn([bin, "plugin", "config-dir", PLUGIN_ID], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const dir = stdout.trim();
  if (exitCode !== 0 || !dir) {
    throw new ConfigLoadError(
      `failed to discover plugin config directory via '${bin} plugin config-dir ${PLUGIN_ID}': ${
        stderr.trim() || `exit ${exitCode}`
      }`,
    );
  }
  return dir;
}

export async function globalConfigPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return join(await resolvePluginConfigDir(env), "config.yaml");
}

/** Herdr-owned plugin state directory for run logs, managed responses, and transcripts. */
export function pluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".hwf", "state");
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, ".hwf", "config.yaml");
}

export function repoLocalConfigPath(repoRoot: string): string {
  return join(repoRoot, ".hwf", "config.local.yaml");
}

/** Ensure `.hwf/.gitignore` covers local config and tmp before the first write. */
export async function ensureLocalConfigGitignored(repoRoot: string): Promise<void> {
  const ignorePath = join(repoRoot, ".hwf", ".gitignore");
  const markers = [basename(repoLocalConfigPath(repoRoot)), "tmp/"];
  let text = (await Bun.file(ignorePath).exists()) ? await Bun.file(ignorePath).text() : "";
  const lines = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  let changed = false;
  for (const marker of markers) {
    if (lines.has(marker)) continue;
    text = text.length === 0 || text.endsWith("\n") ? `${text}${marker}\n` : `${text}\n${marker}\n`;
    changed = true;
  }
  if (changed || !(await Bun.file(ignorePath).exists())) await Bun.write(ignorePath, text);
}

function mergeLayer(into: WorkflowsConfig, layer: WorkflowsConfig): void {
  for (const [name, profile] of Object.entries(layer.profiles)) {
    into.profiles[name] = profile;
  }
  for (const [kind, extractor] of Object.entries(layer.transcripts)) {
    into.transcripts[kind] = extractor;
  }
  if (layer.default_profile !== undefined) {
    into.default_profile = layer.default_profile;
  }
}

/** Merge global → committed repo → local; higher precedence replaces whole entries by name. */
export async function loadConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowsConfig> {
  const merged = emptyConfig();
  const globalPath = await globalConfigPath(env);
  const repoPath = repoConfigPath(repoRoot);
  const localPath = repoLocalConfigPath(repoRoot);
  const globalCfg = await loadFile(globalPath);
  const repoCfg = await loadFile(repoPath);
  const localCfg = await loadFile(localPath);
  let defaultProfileFile: string | undefined;
  if (globalCfg) {
    mergeLayer(merged, globalCfg);
    if (globalCfg.default_profile !== undefined) defaultProfileFile = globalPath;
  }
  if (repoCfg) {
    mergeLayer(merged, repoCfg);
    if (repoCfg.default_profile !== undefined) defaultProfileFile = repoPath;
  }
  if (localCfg) {
    mergeLayer(merged, localCfg);
    if (localCfg.default_profile !== undefined) defaultProfileFile = localPath;
  }
  if (merged.default_profile !== undefined && !(merged.default_profile in merged.profiles)) {
    throw new ConfigLoadError(
      positioned(
        defaultProfileFile ?? repoPath,
        "default_profile",
        `default_profile '${merged.default_profile}' is not a merged profile`,
      ),
    );
  }
  return merged;
}

export function profileNames(config: WorkflowsConfig): string[] {
  return Object.keys(config.profiles).sort();
}

/** Shared hint when merged config has no profiles / no default_profile. */
export function configPathsHint(globalPath: string, repoPath: string): string {
  return `looked in ${globalPath} and ${repoPath}`;
}

export function noProfilesConfiguredMessage(globalPath: string, repoPath: string): string {
  return `no profiles configured (${configPathsHint(globalPath, repoPath)}); run \`hwf init\` or \`hwf init --global\``;
}

export function resolveProfile(config: WorkflowsConfig, name: string): AgentProfile | undefined {
  return config.profiles[name];
}

/**
 * context: native platforms are Linux and macOS. Windows runs under WSL2, where
 * process.platform is already "linux", so no win32 branch can be reached.
 */
export function platformName(platform: string = process.platform): PlatformName {
  return platform === "darwin" ? "macos" : "linux";
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
  worktreePath?: string;
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

function readInvocationContext(): InvocationContext {
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
    worktreePath: json.worktree?.path,
    selection: json.selected_text ?? "",
    cwd:
      json.worktree?.path ||
      json.focused_pane_cwd ||
      json.cwd ||
      json.workspace?.cwd ||
      process.cwd(),
  };
}

export type AppContext = {
  config: WorkflowsConfig;
  repoRoot: string;
  ctx: InvocationContext;
  platform: PlatformName;
  /** Base template namespace (inputs/steps empty; context from invocation). */
  namespace: TemplateNamespace;
};

/** Resolve config layers, repo root, invocation context, platform, and base namespace once. */
export async function loadContext(
  opts: { start?: string; repoRoot?: string; fromInvocation?: boolean } = {},
): Promise<AppContext> {
  const invocation = readInvocationContext();
  const start = opts.start ?? (opts.fromInvocation ? invocation.cwd : process.cwd());
  const repoRoot = opts.repoRoot || process.env.HERDR_WORKFLOWS_REPO_ROOT || resolveRepoRoot(start);
  const ctx: InvocationContext = { ...invocation, cwd: repoRoot };
  const config = await loadConfig(repoRoot);
  const platform = platformName();
  return {
    config,
    repoRoot,
    ctx,
    platform,
    namespace: {
      inputs: {},
      steps: {},
      context: {
        workspace: ctx.workspaceId ?? "",
        tab: ctx.tabId ?? "",
        pane: ctx.paneId ?? "",
        worktree: ctx.worktreePath ?? "",
        agent: "",
        selection: sanitizeDisplay(ctx.selection),
        platform,
      },
    },
  };
}
