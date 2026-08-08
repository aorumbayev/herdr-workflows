import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import manifest from "../herdr-plugin.toml";
import type { AgentSessionInfo } from "./host";

export type PlatformName = "macos" | "linux";

export const PRODUCT_VERSION: string = manifest.version;

export const EXAMPLES_URL = "https://aorumbayev.github.io/herdr-workflows/examples";

/** Best-effort OS browser open — absence of the opener is nonfatal. */
export async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
  } catch {
    /* opener absence is nonfatal */
  }
}

/**
 * Where the workflow contract this build implements is published. Pinned to the release tag for
 * `PRODUCT_VERSION`, because schemas diverge between versions: a pointer at a moving ref would
 * describe some other build's contract to the editor reading it.
 */
export function workflowSchemaUrl(): string {
  return `https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v${PRODUCT_VERSION}/docs/workflow.schema.json`;
}

/** Monotonic latest-wins generation: older in-flight work checks `current(generation)` before applying. */
export type GenerationToken = number;

export function latest(): {
  begin(): GenerationToken;
  current(generation: GenerationToken): boolean;
  bump(): GenerationToken;
} {
  let generation: GenerationToken = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    current(candidate: GenerationToken) {
      return candidate === generation;
    },
    bump() {
      generation += 1;
      return generation;
    },
  };
}

export const WHOLE_TEMPLATE_RE =
  /^\{\{\s*((?:inputs|steps|context)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\s*\}\}$/;

export const CAPTURE_BYTE_LIMIT = 8 * 1024 * 1024;
export const HWF_ENV_BYTE_LIMIT = 24 * 1024;
/**
 * herdr agent.prompt silently drops ~21KB+ bodies; stay under this with a margin.
 * Oversized prompts are written to a run-owned file and replaced by a short pointer.
 */
export const AGENT_PROMPT_BYTE_LIMIT = 16 * 1024;

export class CaptureLimitError extends Error {
  readonly source: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(source: string, bytes: number, limit: number = CAPTURE_BYTE_LIMIT) {
    super(`${source} exceeded ${limit} byte limit (${bytes} bytes)`);
    this.name = "CaptureLimitError";
    this.source = source;
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function assertUnderCaptureCap(source: string, text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError(source, bytes);
}

export function assertUnderHwfEnvCap(source: string, text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes > HWF_ENV_BYTE_LIMIT) throw new CaptureLimitError(source, bytes, HWF_ENV_BYTE_LIMIT);
}

/** Serialize collected inputs as the generated `HWF_*` environment block. */
function formatHwfEnvBlock(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `HWF_${name}=${value}`)
    .join("\n");
}

export function assertHwfEnvValues(source: string, values: Record<string, string>): void {
  assertUnderHwfEnvCap(source, formatHwfEnvBlock(values));
}

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
  const { herdrBinPath } = await import("./host");
  const bin = herdrBinPath(env);
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
};

/** Resolve config layers, repo root, and invocation context once. */
export async function loadContext(
  opts: { start?: string; repoRoot?: string; fromInvocation?: boolean } = {},
): Promise<AppContext> {
  const invocation = readInvocationContext();
  const start = opts.start ?? (opts.fromInvocation ? invocation.cwd : process.cwd());
  const repoRoot = opts.repoRoot || process.env.HERDR_WORKFLOWS_REPO_ROOT || resolveRepoRoot(start);
  const ctx: InvocationContext = { ...invocation, cwd: repoRoot };
  const config = await loadConfig(repoRoot);
  return { config, repoRoot, ctx };
}

const TRANSCRIPT_TIMEOUT_MS = 30_000;

export function slug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

type ContentBlock = { type?: unknown; text?: unknown };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

export function extractSessionTranscript(jsonl: string): string {
  const entries: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = parsed as { type?: unknown; message?: { content?: unknown } };
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (!row.message || row.message.content === undefined) continue;
    const text = extractText(row.message.content);
    if (!text) continue;
    entries.push(`${row.type}:\n${text}`);
  }
  return entries.join("\n\n");
}

export async function readClaudeTranscript(
  cwd: string,
  sessionId: string,
  base = join(homedir(), ".claude", "projects"),
): Promise<string> {
  const { HerdrError } = await import("./host");
  const path = join(base, slug(cwd), `${sessionId}.jsonl`);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError("transcript_file_missing", `transcript file not found: ${path}`);
  }
  try {
    const size = file.size;
    if (size > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError("transcript", size);
    const text = extractSessionTranscript(await file.text());
    assertUnderCaptureCap("transcript", text);
    return text;
  } catch (error) {
    if (error instanceof HerdrError || error instanceof CaptureLimitError) throw error;
    throw new HerdrError(
      "transcript_file_unreadable",
      `transcript file unreadable: ${path}${error instanceof Error ? ` (${error.message})` : ""}`,
    );
  }
}

function transcriptEnv(
  paneId: string,
  info: AgentSessionInfo,
  invocationCwd: string,
): NodeJS.ProcessEnv {
  const cwd = info.cwd || invocationCwd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HWF_TRANSCRIPT_PANE_ID: paneId,
    HWF_TRANSCRIPT_AGENT_KIND: info.agent,
    HWF_TRANSCRIPT_CWD: cwd,
  };
  if (info.sessionKind) env.HWF_TRANSCRIPT_SESSION_KIND = info.sessionKind;
  if (info.sessionId) env.HWF_TRANSCRIPT_SESSION_VALUE = info.sessionId;
  return env;
}

async function runTranscriptCommand(
  argv: string[],
  paneId: string,
  info: AgentSessionInfo,
  invocationCwd: string,
): Promise<string> {
  const { HerdrError } = await import("./host");
  const cwd = info.cwd || invocationCwd;
  const { spawnCapture } = await import("./engine");
  const result = await spawnCapture(argv, {
    cwd,
    env: transcriptEnv(paneId, info, invocationCwd),
    timeoutMs: TRANSCRIPT_TIMEOUT_MS,
    maxCaptureBytes: { source: "transcript" },
  });

  if (result.timedOut) {
    throw new HerdrError(
      "transcript_command_failed",
      `transcript command for '${info.agent}' failed: timed out after ${result.timeoutMs / 1000}s`,
    );
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-500) || `exit ${result.exitCode}`;
    throw new HerdrError(
      "transcript_command_failed",
      `transcript command for '${info.agent}' failed: ${tail}`,
    );
  }
  if (!result.stdout.trim()) {
    throw new HerdrError(
      "transcript_command_empty",
      `transcript command for '${info.agent}' printed nothing`,
    );
  }
  assertUnderCaptureCap("transcript", result.stdout);
  return result.stdout;
}

export function hasTranscriptSupport(
  agentKind: string,
  transcripts: Record<string, TranscriptExtractor>,
): boolean {
  return agentKind in transcripts || agentKind === "claude";
}

export async function transcriptText(
  paneId: string,
  transcripts: Record<string, TranscriptExtractor> = {},
  opts: {
    invocationCwd: string;
    projectsBase?: string;
    getInfo?: (paneId: string) => Promise<AgentSessionInfo>;
  },
): Promise<string> {
  const { HerdrError, agentSessionInfo } = await import("./host");
  const getInfo = opts.getInfo ?? agentSessionInfo;
  const info = await getInfo(paneId);
  const extractor = transcripts[info.agent];
  if (extractor) {
    return runTranscriptCommand(extractor.command, paneId, info, opts.invocationCwd);
  }
  if (!hasTranscriptSupport(info.agent, transcripts)) {
    throw new HerdrError(
      "transcript_unsupported_kind",
      `no transcript extractor for '${info.agent}' and no built-in support for that kind`,
    );
  }
  const cwd = info.cwd || opts.invocationCwd;
  if (!info.sessionId) {
    throw new HerdrError(
      "transcript_unsupported_kind",
      `no transcript extractor for '${info.agent}' and built-in support requires a native session value`,
    );
  }
  return readClaudeTranscript(cwd, info.sessionId, opts.projectsBase);
}
