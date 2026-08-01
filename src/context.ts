import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import manifest from "../herdr-plugin.toml";
import { agentSessionInfo, HerdrError, type AgentSessionInfo } from "./host";
import type { PlatformName, TemplateNamespace } from "./workflow/types";

export const PRODUCT_VERSION: string = manifest.version;

export const EXAMPLES_URL = "https://aorumbayev.github.io/herdr-workflows/examples";

/**
 * Where the workflow contract this build implements is published. Pinned to the release tag for
 * `PRODUCT_VERSION`, because schemas diverge between versions: a pointer at a moving ref would
 * describe some other build's contract to the editor reading it.
 */
export function workflowSchemaUrl(): string {
  return `https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v${PRODUCT_VERSION}/docs/workflow.schema.json`;
}

/** Monotonic latest-wins token: older in-flight work checks `current(token)` before applying. */
export function latest(): {
  begin(): number;
  current(token: number): boolean;
  bump(): number;
} {
  let gen = 0;
  return {
    begin() {
      gen += 1;
      return gen;
    },
    current(token: number) {
      return token === gen;
    },
    bump() {
      gen += 1;
      return gen;
    },
  };
}

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

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export type AclGrant = { principal: string; allow: boolean };

/**
 * Best-effort private credential location check.
 *
 * Mode bits and ACL stripping cover POSIX discretionary access and common ACL
 * inheritance. A filesystem with no permission model (some network mounts) still
 * cannot be proven safe — callers refuse only what the platform can observe.
 */
export type CredentialStoreAssertOpts = {
  chmodFn?: (path: string, mode: number) => Promise<void>;
  statFn?: (path: string) => Promise<{ mode: number }>;
  mkdirFn?: typeof mkdir;
  stripAclFn?: (path: string) => Promise<void>;
  readAclFn?: (path: string) => Promise<AclGrant[] | null>;
  uidFn?: () => number;
};

function runQuiet(
  command: string,
  args: string[],
): {
  status: number | null;
  stdout: string;
  missing: boolean;
} {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const missing = result.error != null && (result.error as NodeJS.ErrnoException).code === "ENOENT";
  return { status: result.status, stdout: result.stdout ?? "", missing };
}

function stripExtendedAcls(path: string): void {
  if (platform() === "darwin") {
    runQuiet("/bin/chmod", ["-N", path]);
    return;
  }
  if (platform() === "linux") {
    const probe = runQuiet("setfacl", ["-b", path]);
    if (probe.missing) return;
  }
}

/** Parse macOS `/bin/ls -lde` / `-le` numbered ACE lines into grants. */
export function parseDarwinAclListing(stdout: string): AclGrant[] {
  const grants: AclGrant[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*\d+:\s+(\S+)(?:\s+inherited)?\s+(allow|deny)\s+/.exec(line);
    if (!match) continue;
    grants.push({ principal: match[1]!, allow: match[2] === "allow" });
  }
  return grants;
}

/** Parse `getfacl -cp` named entries; owning user:/group: blanks are mode bits, not ACEs. */
export function parseLinuxAclListing(stdout: string): AclGrant[] {
  const grants: AclGrant[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(user|group|other|mask):([^:]*):([rwx-]+)/.exec(trimmed);
    if (!match) continue;
    const kind = match[1]!;
    const name = match[2]!;
    const perms = match[3]!;
    if (perms === "---") continue;
    if (kind === "mask") continue;
    if (kind === "user" && name === "") continue;
    if (kind === "group" && name === "") continue;
    if (kind === "other") continue;
    grants.push({ principal: `${kind}:${name}`, allow: true });
  }
  return grants;
}

function readExtendedAcls(path: string): AclGrant[] | null {
  if (platform() === "darwin") {
    const listed = runQuiet("/bin/ls", ["-lde", path]);
    if (listed.status !== 0) {
      const fileListed = runQuiet("/bin/ls", ["-le", path]);
      if (fileListed.status !== 0) return [];
      return parseDarwinAclListing(fileListed.stdout);
    }
    return parseDarwinAclListing(listed.stdout);
  }
  if (platform() === "linux") {
    const listed = runQuiet("getfacl", ["-cp", path]);
    if (listed.missing || listed.status !== 0) return null;
    return parseLinuxAclListing(listed.stdout);
  }
  return null;
}

function ownerPrincipalHints(uid: number): Set<string> {
  const hints = new Set<string>(["owner", "owner@", `user:${uid}`]);
  try {
    const name = userInfo().username;
    if (name) {
      hints.add(name);
      hints.add(`user:${name}`);
    }
  } catch {
    /* ignore */
  }
  return hints;
}

function foreignAllowGrant(grant: AclGrant, ownerHints: Set<string>): boolean {
  if (!grant.allow) return false;
  return !ownerHints.has(grant.principal);
}

function assertModePrivate(path: string, mode: number, kind: "store" | "file"): void {
  if ((mode & 0o077) !== 0) {
    throw new CredentialStoreError(
      kind === "file"
        ? `refusing credential file with group/world access: ${path}`
        : `refusing credential store with group/world access: ${path}`,
    );
  }
}

function assertNoForeignAclAccessSync(path: string, uid: number): void {
  stripExtendedAcls(path);
  const grants = readExtendedAcls(path);
  if (grants === null) return;
  const ownerHints = ownerPrincipalHints(uid);
  for (const grant of grants) {
    if (foreignAllowGrant(grant, ownerHints)) {
      throw new CredentialStoreError(`refusing credential store with foreign ACL grant at ${path}`);
    }
  }
}

async function assertNoForeignAclAccess(
  path: string,
  opts: Pick<CredentialStoreAssertOpts, "stripAclFn" | "readAclFn" | "uidFn"> = {},
): Promise<void> {
  const stripAclFn = opts.stripAclFn ?? (async (p) => stripExtendedAcls(p));
  const readAclFn = opts.readAclFn ?? (async (p) => readExtendedAcls(p));
  const uidFn = opts.uidFn ?? (() => process.getuid?.() ?? -1);

  await stripAclFn(path);
  const grants = await readAclFn(path);
  if (grants === null) return;
  const ownerHints = ownerPrincipalHints(uidFn());
  for (const grant of grants) {
    if (foreignAllowGrant(grant, ownerHints)) {
      throw new CredentialStoreError(`refusing credential store with foreign ACL grant at ${path}`);
    }
  }
}

async function ensurePrivateDir(
  dir: string,
  mode: number,
  opts: CredentialStoreAssertOpts,
): Promise<void> {
  const chmodFn = opts.chmodFn ?? ((path, m) => chmod(path, m));
  const statFn = opts.statFn ?? ((path) => stat(path));
  const mkdirFn = opts.mkdirFn ?? mkdir;

  await mkdirFn(dir, { recursive: true, mode });
  await chmodFn(dir, mode);
  assertModePrivate(dir, (await statFn(dir)).mode & 0o777, "store");
  await assertNoForeignAclAccess(dir, opts);
}

/**
 * Ensure `stateDir` grants no read/write to any principal other than the current
 * user before writing bearer tokens there.
 */
export async function assertCredentialStoreSafe(
  stateDir: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  await ensurePrivateDir(stateDir, 0o700, opts);
}

/** Tighten and verify a credential file is private to the current user. */
export async function assertPrivateCredentialFile(
  path: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  const chmodFn = opts.chmodFn ?? ((p, mode) => chmod(p, mode));
  const statFn = opts.statFn ?? ((p) => stat(p));

  await chmodFn(path, 0o600);
  assertModePrivate(path, (await statFn(path)).mode & 0o777, "file");
  await assertNoForeignAclAccess(path, opts);
}

/** Sync counterpart for lock-file creation on the hot path. */
export function assertPrivateCredentialFileSync(path: string): void {
  chmodSync(path, 0o600);
  assertModePrivate(path, statSync(path).mode & 0o777, "file");
  assertNoForeignAclAccessSync(path, process.getuid?.() ?? -1);
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
