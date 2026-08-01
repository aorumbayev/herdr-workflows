#!/usr/bin/env bun
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Command, InvalidArgumentError, Option } from "commander";
import manifest from "../herdr-plugin.toml";
import { appendRouteHash, openWorkbench, parseWebRoute } from "./workbench";
import { buildIdentity, parseLaunchPayload, retireOnCodeChange, runWorkflow } from "./engine";
import { ensureHerdrProtocol, HerdrError, notificationShow, pluginPaneOpen } from "./host";
import { evaluateWhen, resolveDynamicChoices } from "./workflow/inputs";
import { IMPORT_DISCLAIMER, parseImportScope, runImport } from "./workflow/exchange";
import { listWorkflows, loadWorkflow } from "./workflow/inputs";
import {
  PRODUCT_VERSION,
  ensureLocalConfigGitignored,
  globalConfigPath,
  parseConfigText,
  PROFILE_NAME_RE,
  repoConfigPath,
  loadContext,
  resolveRepoRoot,
  EXAMPLES_URL,
  CaptureLimitError,
  openInBrowser,
  type AgentProfile,
  type WorkflowsConfig,
} from "./context";
import {
  WORKFLOW_FORMAT,
  WorkflowLoadError,
  type InputSpec,
  type WhenSpec,
} from "./workflow/grammar";
import { ReleaseCheckError, updatePlugin, type UpdateDeps, type UpdateResult } from "./update";

/**
 * Survive a reader that left. A detached `hwf run` outlives the picker holding the read end of its
 * pipes; without a listener the EPIPE surfaces as an uncaught stream error and kills the run
 * part-way through the workflow. The write is async, so a try/catch at the call site never sees it.
 */
export function tolerateClosedStdio(): void {
  process.stdout.on("error", tolerateClosedPipe);
  process.stderr.on("error", tolerateClosedPipe);
}

function tolerateClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
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

/** Drop the shared stdin lock so short-lived CLI commands can exit after prompts. */
export async function releaseStdinReader(): Promise<void> {
  const r = reader;
  if (!r) return;
  reader = undefined;
  stdinBuf = "";
  try {
    await r.cancel();
  } catch {
    /* already closed */
  }
}

const OWNERSHIP_FILE = ".herdr-workflows-cli.json";

export function resolveBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_BIN_HOME?.trim()) return resolve(env.XDG_BIN_HOME.trim());
  return join(homedir(), ".local", "bin");
}

function binDirOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PATH ?? "";
  return path.split(delimiter).some((entry) => entry && resolve(entry) === resolve(dir));
}

/** Plugin checkout root: HERDR_PLUGIN_ROOT, else parent of a compiled bin/, else cwd. */
export function resolvePluginRoot(
  env: NodeJS.ProcessEnv = process.env,
  opts: { execPath?: string; cwd?: string } = {},
): string {
  const injected = env.HERDR_PLUGIN_ROOT?.trim();
  if (injected) return resolve(injected);
  const execPath = opts.execPath ?? process.execPath;
  const base = basename(execPath).toLowerCase();
  if (base === "herdr-workflows" || base === "hwf") {
    const parent = dirname(execPath);
    if (basename(parent).toLowerCase() === "bin") return resolve(dirname(parent));
  }
  return resolve(opts.cwd ?? process.cwd());
}

/** Managed checkout binary path. */
function resolveManagedBinary(pluginRoot: string): string | undefined {
  const bare = join(pluginRoot, "bin", "herdr-workflows");
  if (existsSync(bare)) return bare;
  return undefined;
}

function isEphemeralPluginRoot(pluginRoot: string): boolean {
  return pluginRoot.split(sep).some((part) => part.startsWith(".tmp-install-"));
}

/** Config.toml Herdr reads on this host. */
export function resolveHerdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_CONFIG_PATH?.trim()) return env.HERDR_CONFIG_PATH.trim();
  const base = env.XDG_CONFIG_HOME?.trim()
    ? join(env.XDG_CONFIG_HOME.trim(), "herdr")
    : join(homedir(), ".config", "herdr");
  return join(base, "config.toml");
}

type OwnedKind = "symlink" | "copy";

type OwnershipEntry = {
  kind: OwnedKind;
  version: string;
  source?: string;
};

export type OwnershipRegistry = {
  version: string;
  entries: Record<string, OwnershipEntry>;
};

function ownershipPath(binDir: string): string {
  return join(binDir, OWNERSHIP_FILE);
}

export function readOwnership(binDir: string): OwnershipRegistry {
  try {
    const raw = JSON.parse(readFileSync(ownershipPath(binDir), "utf8")) as OwnershipRegistry;
    if (!raw || typeof raw !== "object" || typeof raw.entries !== "object") {
      return { version: PRODUCT_VERSION, entries: {} };
    }
    return { version: raw.version || PRODUCT_VERSION, entries: raw.entries ?? {} };
  } catch {
    return { version: PRODUCT_VERSION, entries: {} };
  }
}

function writeOwnership(binDir: string, registry: OwnershipRegistry): void {
  writeFileSync(
    ownershipPath(binDir),
    `${JSON.stringify({ ...registry, version: PRODUCT_VERSION }, null, 2)}\n`,
  );
}

export type CliInstallResult = {
  messages: string[];
};

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function mark(registry: OwnershipRegistry, name: string, kind: OwnedKind, source: string): void {
  registry.entries[name] = { kind, version: PRODUCT_VERSION, source };
}

function installPosixName(
  dir: string,
  name: string,
  source: string,
  kind: OwnedKind,
  registry: OwnershipRegistry,
  messages: string[],
): string | null {
  const dest = join(dir, name);
  const entry = registry.entries[name];

  if (entryExists(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(dest), readlinkSync(dest));
      const owned =
        entry?.kind === "symlink" &&
        typeof entry.source === "string" &&
        target === resolve(entry.source);
      if (kind === "symlink" && target === resolve(source) && owned) {
        messages.push(`${name} already linked at ${dest}`);
        return dest;
      }
      if (!owned) {
        messages.push(`skipped cli install: ${dest} exists and is not owned by herdr-workflows`);
        return null;
      }
      unlinkSync(dest);
    } else if (entry?.kind === "copy") {
      unlinkSync(dest);
    } else {
      messages.push(`skipped cli install: ${dest} exists and is not owned by herdr-workflows`);
      return null;
    }
  }

  if (kind === "copy") {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    mark(registry, name, "copy", resolve(source));
    messages.push(`copied ${source} → ${dest}`);
    return dest;
  }

  try {
    symlinkSync(source, dest);
    mark(registry, name, "symlink", resolve(source));
    messages.push(`linked ${source} → ${dest}`);
  } catch {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    mark(registry, name, "copy", resolve(source));
    messages.push(`copied ${source} → ${dest} (symlink unavailable)`);
  }
  return dest;
}

export function installCliCommands(opts: {
  binDir: string;
  binary: string;
  ephemeral: boolean;
}): CliInstallResult {
  const messages: string[] = [];
  mkdirSync(opts.binDir, { recursive: true });
  const registry = readOwnership(opts.binDir);

  // Ephemeral roots (herdr temp build checkouts) get one binary copy; `hwf` symlinks to that
  // copy instead of duplicating ~73 MiB or dangling into the moved checkout.
  const primary = installPosixName(
    opts.binDir,
    "herdr-workflows",
    opts.binary,
    opts.ephemeral ? "copy" : "symlink",
    registry,
    messages,
  );
  const hwf =
    opts.ephemeral && primary
      ? { source: primary, kind: "symlink" as const }
      : { source: opts.binary, kind: opts.ephemeral ? ("copy" as const) : ("symlink" as const) };
  installPosixName(opts.binDir, "hwf", hwf.source, hwf.kind, registry, messages);

  writeOwnership(opts.binDir, registry);
  return { messages };
}

const BINDINGS = [
  {
    marker: "herdr-workflows.launch",
    block: `
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "herdr-workflows.launch"
description = "launch a herdr-workflows workflow (picker)"
`,
  },
];

const DEAD_ACTIONS = new Set([
  "kagan.launch",
  "kagan.results",
  "kagan.reconcile",
  "kagan.confirm",
  "kagan.flag",
  "lembas.launch",
  "lembas.results",
  "lembas.reconcile",
  "lembas.confirm",
  "lembas.flag",
  "herdr-workflows.results",
  "herdr-workflows.reconcile",
  "herdr-workflows.confirm",
  "herdr-workflows.flag",
]);

export type KeybindingInstallResult = {
  messages: string[];
  path: string;
};

function herdrBin(env: NodeJS.ProcessEnv): string {
  return env.HERDR_BIN_PATH?.trim() || "herdr";
}

function spawnHerdr(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { encoding?: "utf8"; stdio?: "ignore" } = {},
) {
  return spawnSync(herdrBin(env), args, {
    ...opts,
    env,
  });
}

function validates(candidate: string, env: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const check = spawnHerdr(
    ["config", "check"],
    {
      ...env,
      HERDR_CONFIG_PATH: candidate,
    },
    { encoding: "utf8" },
  );
  if (check.error) return { ok: false, out: check.error.message };
  const out = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  return { ok: out.includes("config: ok"), out };
}

/** Drop whole `[[keys.command]]` tables whose command is a retired action. */
export function stripDeadBindings(text: string): string {
  const parts = text.split(/(\[\[keys\.command\]\])/);
  if (parts.length === 1) return text;
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i] ?? "";
    const body = parts[i + 1] ?? "";
    const command = body.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1];
    if (command && DEAD_ACTIONS.has(command)) continue;
    out += header + body;
  }
  return out;
}

export function installKeybindings(opts: {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
}): KeybindingInstallResult {
  const env = opts.env ?? process.env;
  const path = resolveHerdrConfigPath(env);
  const messages: string[] = [];

  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const cleaned = original === null ? null : stripDeadBindings(original);
  const missing = BINDINGS.filter((b) => cleaned === null || !cleaned.includes(b.marker));
  if (missing.length === 0 && cleaned === original) {
    messages.push("herdr-workflows keybindings already present; skipping");
    return { messages, path };
  }

  mkdirSync(dirname(path), { recursive: true });
  const prefix = cleaned && !cleaned.endsWith("\n") ? "\n" : "";
  const next = `${cleaned ?? ""}${prefix}${missing.map((b) => b.block).join("")}`;

  const tmp = `${path}.hwf.tmp`;
  writeFileSync(tmp, next);
  const check = validates(tmp, env);
  if (!check.ok) {
    rmSync(tmp, { force: true });
    messages.push("herdr-workflows keybinding install skipped — herdr config check failed:");
    messages.push(check.out.trim() || "(no output)");
    return { messages, path };
  }

  if (original !== null) writeFileSync(`${path}.hwf.bak`, original);
  renameSync(tmp, path);
  const parts: string[] = [];
  if (missing.length) parts.push(`added ${missing.map((b) => b.marker).join(", ")}`);
  if (cleaned !== original) parts.push("removed dead herdr-workflows.* bindings");
  messages.push(
    `${parts.join("; ")} in ${path}${original !== null ? " (backup: config.toml.hwf.bak)" : ""}`,
  );

  if (opts.reload !== false) {
    const reload = spawnHerdr(["server", "reload-config"], env, { encoding: "utf8" });
    if (reload.error || (reload.status ?? 1) !== 0) {
      const detail =
        reload.error?.message ||
        `${reload.stderr ?? ""}${reload.stdout ?? ""}`.trim() ||
        `exit ${reload.status ?? 1}`;
      messages.push(
        `herdr server reload-config failed (${detail}) — wrote ${path} but the running Herdr may not have loaded the binding yet`,
      );
    } else {
      messages.push(`herdr reloaded config so the running server reads ${path}`);
    }
  }
  return { messages, path };
}

/** Nonfatal host setup: PATH commands + picker keybinding. Never throws to callers. */
export function runSetup(): void {
  const log = (line: string) => process.stdout.write(`${line}\n`);

  try {
    const env = process.env;
    const binDir = resolveBinDir(env);

    const pluginRoot = resolvePluginRoot(env);
    const binary = resolveManagedBinary(pluginRoot);
    if (!binary) {
      log(`skipped cli install: managed binary not found under ${pluginRoot} (run build first)`);
    } else {
      const cli = installCliCommands({
        binDir,
        binary,
        ephemeral: isEphemeralPluginRoot(pluginRoot),
      });
      for (const line of cli.messages) log(line);
    }

    if (!binDirOnPath(binDir, env)) {
      log(`warning: ${binDir} is not on PATH — add it to your shell profile`);
    }

    const keys = installKeybindings({ env });
    for (const line of keys.messages) log(line);
  } catch (error) {
    log(`skipped setup: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * `hwf update` CLI presentation — domain policy lives in `./update`.
 * Must not import the picker module.
 */
export async function runUpdate(deps: UpdateDeps = {}): Promise<void> {
  let result: UpdateResult;
  try {
    result = await updatePlugin({
      ...deps,
      pluginRoot: deps.pluginRoot ?? resolvePluginRoot(),
      beforeInstall:
        deps.beforeInstall ??
        ((info) => {
          process.stdout.write(
            `updating ${info.from} → ${info.to} via herdr plugin install ${info.repo}\n`,
          );
        }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error instanceof ReleaseCheckError) die(`update check failed: ${msg}`);
    die(`update failed: ${msg}`);
  }
  presentUpdateResult(result);
}

function presentUpdateResult(result: UpdateResult): void {
  switch (result.kind) {
    case "up_to_date":
      process.stdout.write(`already up to date (${result.current})\n`);
      return;
    case "refused_local":
      die(
        `refusing to update a linked development checkout — run bun run install:dev from the working tree instead`,
      );
    case "refused_unregistered":
      die(
        `this binary is not a Herdr-managed herdr-workflows install — run: herdr plugin install ${result.repo}`,
      );
    case "updated":
      process.stdout.write(`updated to ${result.to}\n`);
      return;
    case "install_failed":
      process.stderr.write(`herdr plugin install failed with exit ${result.code}\n`);
      process.exit(result.code);
  }
}

/** Kinds `herdr agent start --kind` accepts (herdr 0.7.5 cli-reference). Native start stays authoritative. */
const HERDR_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "maki",
] as const;

/** Probe subset: kinds above whose canonical executable name is known. */
const KNOWN_KINDS: { name: (typeof HERDR_AGENT_KINDS)[number]; bin: string }[] = [
  { name: "claude", bin: "claude" },
  { name: "codex", bin: "codex" },
  { name: "cursor", bin: "cursor" },
  { name: "opencode", bin: "opencode" },
];

async function onPath(bin: string): Promise<boolean> {
  return Bun.which(bin) !== null;
}

async function detectProfiles(): Promise<Record<string, AgentProfile>> {
  const profiles: Record<string, AgentProfile> = {};
  for (const kind of KNOWN_KINDS) {
    if (!PROFILE_NAME_RE.test(kind.name)) continue;
    if (await onPath(kind.bin)) profiles[kind.name] = { kind: kind.name };
  }
  return profiles;
}

function formatProfilesYaml(config: {
  profiles: Record<string, AgentProfile>;
  default_profile?: string;
  transcripts?: WorkflowsConfig["transcripts"];
}): string {
  const lines: string[] = ["profiles:"];
  const names = Object.keys(config.profiles).sort();
  if (names.length === 0) {
    lines.push("  {}");
  } else {
    for (const name of names) {
      const profile = config.profiles[name]!;
      lines.push(`  ${name}:`);
      lines.push(`    kind: ${JSON.stringify(profile.kind)}`);
      if (profile.args && profile.args.length > 0) {
        const args = profile.args.map((a) => JSON.stringify(a)).join(", ");
        lines.push(`    args: [${args}]`);
      }
    }
  }
  if (config.default_profile) {
    lines.push(`default_profile: ${JSON.stringify(config.default_profile)}`);
  }
  if (config.transcripts && Object.keys(config.transcripts).length > 0) {
    lines.push("transcripts:");
    for (const kind of Object.keys(config.transcripts).sort()) {
      const command = config.transcripts[kind]!.command.map((a) => JSON.stringify(a)).join(", ");
      lines.push(`  ${kind}:`);
      lines.push(`    command: [${command}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function readPreservedTranscripts(path: string): Promise<WorkflowsConfig["transcripts"]> {
  try {
    if (!(await Bun.file(path).exists())) return {};
    return parseConfigText(path, await Bun.file(path).text()).transcripts;
  } catch {
    return {};
  }
}

type InitResult =
  | { kind: "wrote"; path: string; profiles: string[] }
  | { kind: "exists"; path: string }
  | { kind: "overwritten"; path: string; profiles: string[] };

export async function runInit(
  repoRoot: string,
  opts: {
    force?: boolean;
    confirm?: () => Promise<boolean>;
    global?: boolean;
  } = {},
): Promise<InitResult> {
  const path = opts.global ? await globalConfigPath() : repoConfigPath(repoRoot);
  const existed = await Bun.file(path).exists();
  if (existed && !opts.force) {
    if (!opts.confirm) return { kind: "exists", path };
    if (!(await opts.confirm())) return { kind: "exists", path };
  }

  const profiles = await detectProfiles();
  const names = Object.keys(profiles).sort();

  await mkdir(dirname(path), { recursive: true });
  if (!opts.global) {
    await mkdir(join(repoRoot, ".hwf", "workflows"), { recursive: true });
    await ensureLocalConfigGitignored(repoRoot);
  }

  const transcripts = existed ? await readPreservedTranscripts(path) : {};
  await Bun.write(
    path,
    formatProfilesYaml({
      profiles,
      ...(names[0] !== undefined ? { default_profile: names[0] } : {}),
      transcripts,
    }),
  );

  return existed
    ? { kind: "overwritten", path, profiles: names }
    : { kind: "wrote", path, profiles: names };
}

/** Declared internal seam — unit tests pin detect/format without widening the CLI export surface. */
export const initSeams = {
  HERDR_AGENT_KINDS,
  detectProfiles,
  formatProfilesYaml,
};

function collectInput(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new InvalidArgumentError(`--input expects name=value, got '${value}'`);
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`--port expects an integer between 1 and 65535, got '${value}'`);
  }
  return port;
}

async function cmdInit(opts: { force?: boolean; global?: boolean }): Promise<void> {
  const global = Boolean(opts.global);
  const repoRoot = await resolveRepoRoot();
  let prompted = false;
  const result = await runInit(repoRoot, {
    force: Boolean(opts.force),
    global,
    confirm: async () => {
      if (!process.stdin.isTTY) return false;
      prompted = true;
      const label = global ? "global plugin config" : ".hwf/config.yaml";
      process.stdout.write(`${label} exists — overwrite? [y/N] `);
      const line = await readLine();
      return line.kind === "line" && line.text.trim().toLowerCase() === "y";
    },
  });
  if (prompted) await releaseStdinReader();
  if (result.kind === "exists") die(`${result.path} already exists (pass --force to overwrite)`);
  const profiles = result.profiles.length
    ? ` (${result.profiles.join(", ")})`
    : " (no agent kinds on PATH)";
  process.stdout.write(
    `wrote ${result.path}${profiles}\n` +
      (global
        ? `profiles apply to every repo; keep personal workflows in ~/.hwf/workflows\n`
        : `no workflows yet — pick ready-made ones at ${EXAMPLES_URL}\n` +
          `each card copies an \`hwf workflow import\` command you can paste here\n`),
  );
}

async function cmdWorkflowImport(
  payload: string,
  opts: { to?: "repo" | "global"; yes?: boolean; force?: boolean },
): Promise<void> {
  const scope = opts.to;
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const preapproved = Boolean(opts.yes);
  if (!tty && !(preapproved && scope)) {
    die("not a tty: pass --yes and --to=repo|global to import without the review prompts");
  }
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
  const interactive = !preapproved;
  try {
    const outcome = await runImport(payload, {
      repoRoot,
      scope,
      force: Boolean(opts.force),
      prompts: preapproved
        ? undefined
        : {
            confirm: async (preview) => {
              process.stdout.write(`${IMPORT_DISCLAIMER}\n\n${preview}\n`);
              process.stdout.write("Reviewed the workflow above and want it? [y/N] ");
              const line = await readLine();
              return line.kind === "line" && line.text.trim().toLowerCase() === "y";
            },
            chooseScope: async () => {
              process.stdout.write(`Install into [r]epo ${repoRoot}/.hwf / [g]lobal ~/.hwf [R]: `);
              const line = await readLine();
              if (line.kind !== "line") return "repo";
              return parseImportScope(line.text || "r") ?? "repo";
            },
          },
    });
    if ("aborted" in outcome) {
      process.stdout.write("aborted — nothing written\n");
      return;
    }
    const r = outcome.result;
    if (r.status === "conflicts") {
      const names = r.conflicts.map((c) => c.name).join(", ");
      die(`existing workflows would be replaced (${names}); pass --force to replace all`);
    }
    for (const row of r.results) {
      process.stdout.write(`wrote ${row.path}\n`);
    }
  } catch (error) {
    if (error instanceof WorkflowLoadError || error instanceof CaptureLimitError)
      die(error.message);
    throw error;
  } finally {
    if (interactive) await releaseStdinReader();
  }
}

function formatWhenClause(clause: WhenSpec): string {
  if (clause.kind === "truthy") return `{{${clause.path}}}`;
  return `{{${clause.path}}} ${clause.negate ? "!=" : "=="} ${JSON.stringify(clause.value)}`;
}

function formatInputInspect(spec: InputSpec, resolved?: string[]): string[] {
  const lines = [`${spec.name}:`];
  lines.push(`  type: ${spec.type}`);
  if (spec.description) lines.push(`  description: ${spec.description}`);
  if (spec.when && spec.when.length > 0) {
    const text =
      spec.when.length === 1
        ? formatWhenClause(spec.when[0]!)
        : `[${spec.when.map(formatWhenClause).join(", ")}]`;
    lines.push(`  when: ${text}`);
  }
  if (spec.default !== undefined) lines.push(`  default: ${spec.default}`);
  if (spec.minLength !== undefined) lines.push(`  min_length: ${spec.minLength}`);
  if (spec.allowCustom === true) lines.push(`  allow_custom: true`);
  if (spec.dynamicOptions) {
    lines.push(
      `  options.run: [${spec.dynamicOptions.run.map((el) => JSON.stringify(el)).join(", ")}]`,
    );
    if (resolved) {
      lines.push(`  options: [${resolved.map((el) => JSON.stringify(el)).join(", ")}]`);
    }
  } else if (spec.options) {
    lines.push(`  options: [${spec.options.map((el) => JSON.stringify(el)).join(", ")}]`);
  }
  return lines;
}

async function cmdWorkflowInspect(
  name: string,
  opts: { input?: Record<string, string>; resolve?: boolean },
): Promise<void> {
  const { repoRoot, config } = await loadContext();
  let workflow;
  try {
    workflow = await loadWorkflow(name, repoRoot, config);
  } catch (error) {
    if (error instanceof WorkflowLoadError) die(error.message);
    throw error;
  }
  const provided = opts.input ?? {};
  for (const key of Object.keys(provided)) {
    if (!workflow.inputs.some((input) => input.name === key)) {
      die(`unknown input '${key}'`);
    }
  }
  const domains: Record<string, string[]> = {};
  const values: Record<string, string> = { ...provided };
  if (opts.resolve) {
    for (const spec of workflow.inputs) {
      if (!evaluateWhen(spec.when, { inputs: values, steps: {}, context: {} })) continue;
      if (spec.default !== undefined && !Object.hasOwn(values, spec.name)) {
        values[spec.name] = spec.default;
      }
      if (spec.dynamicOptions) {
        try {
          domains[spec.name] = await resolveDynamicChoices(
            workflow.file,
            spec.name,
            spec.dynamicOptions,
            repoRoot,
          );
        } catch (error) {
          die(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
  const lines: string[] = [`workflow: ${workflow.name}`, `inputs:`];
  if (workflow.inputs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const spec of workflow.inputs) {
      lines.push(
        ...formatInputInspect(spec, opts.resolve ? domains[spec.name] : undefined).map(
          (line) => `  ${line}`,
        ),
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function cmdLaunch(): Promise<void> {
  await ensureHerdrProtocol();
  // Picker popup cwd is the plugin dir; forward invocation repo + context.
  const { repoRoot } = await loadContext({ fromInvocation: true });
  const env: Record<string, string> = { HERDR_WORKFLOWS_REPO_ROOT: repoRoot };
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON)
    env.HERDR_PLUGIN_CONTEXT_JSON = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  try {
    await pluginPaneOpen({ entrypoint: "picker", placement: "popup", env });
  } catch (error) {
    if (error instanceof HerdrError && error.code === "ui_busy") {
      await notificationShow("herdr-workflows", "Another popup is open — close it first.");
      return;
    }
    throw error;
  }
}

async function cmdRun(
  name: string,
  opts: { input?: Record<string, string>; launchPayload?: boolean },
): Promise<void> {
  await ensureHerdrProtocol();
  let inputs: Record<string, string> = {};
  let domains: Record<string, string[]> | undefined;
  let runId: string | undefined;
  if (opts.launchPayload) {
    let payload;
    try {
      payload = parseLaunchPayload(await Bun.stdin.text());
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
    if (payload.name !== name) {
      die(`launch payload name '${payload.name}' does not match run name '${name}'`);
    }
    inputs = payload.inputs;
    domains = payload.domains;
    runId = payload.runId;
  }
  inputs = { ...inputs, ...opts.input };
  const { repoRoot, config, ctx } = await loadContext();
  try {
    const result = await runWorkflow({
      name,
      repoRoot,
      config,
      ctx,
      inputs,
      ...(domains !== undefined ? { domains } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(opts.launchPayload ? { resolveDynamic: false } : {}),
      onHistoryAck: (line) => {
        process.stdout.write(`${line}\n`);
      },
      onProgress: (i, n, label, outcome = "ok") => {
        if (outcome === "start") {
          process.stdout.write(`[${i}/${n}] ${label}…\n`);
          return;
        }
        const suffix = outcome === "ok" ? "" : ` ${outcome}`;
        process.stdout.write(`[${i}/${n}] ${label}${suffix}\n`);
      },
      onStderr: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
    });
    if (!result.ok) die(result.error);
  } catch (error) {
    if (error instanceof WorkflowLoadError) die(error.message);
    throw error;
  }
}

function registerOwnedWorkbenchShutdown(shutdown: () => void): void {
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function cmdWeb(
  routeRaw: string | undefined,
  opts: { port?: number; open?: boolean },
): Promise<void> {
  const port = opts.port;
  const route = routeRaw === undefined ? undefined : parseWebRoute(routeRaw);
  if (routeRaw !== undefined && !route) {
    die(
      `web route expects w=<repo|global>:<name>, share=<repo|global>:<name>, run=<uuid>, import, or new, got '${routeRaw}'`,
    );
  }
  const { repoRoot } = await loadContext();
  const workbench = await openWorkbench({ repoRoot, port, build: buildIdentity() });
  const url = appendRouteHash(workbench.url, route);
  // Open before printing: a detached picker handoff can already have a dead stdout.
  if (opts.open !== false) void openInBrowser(url);
  process.stdout.write(`herdr-workflows web · ${url}\n`);
  if (!workbench.owned) return;
  const shutdown = () => {
    workbench.stop();
    process.exit(0);
  };
  registerOwnedWorkbenchShutdown(shutdown);
  // Only a dev script entry watches: a compiled build is refused at adoption by identity, so
  // stopping here frees the port rather than upholding the invariant.
  retireOnCodeChange(shutdown);
}

// bun --compile re-extracts the embedded libopentui to a temp file per spawn (~200ms on the
// picker hot path); point opentui at the on-disk copy when node_modules is present.
function preferOnDiskOpentuiLib(): void {
  if (process.env.OTUI_ASSET_ROOT) return;
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const musl = process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : "";
  const asset = join(
    `@opentui/core-${process.platform}-${process.arch}${musl}`,
    process.platform === "darwin" ? "libopentui.dylib" : "libopentui.so",
  );
  const roots = [
    join(dirname(process.execPath), "..", "node_modules"), // compiled: bin/../node_modules
    join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules"), // dev: src/../node_modules
  ];
  for (const root of roots) {
    if (existsSync(join(root, asset))) {
      process.env.OTUI_ASSET_ROOT = root;
      return;
    }
  }
}

async function runPickerPopup(
  pickerImport: Promise<typeof import("./picker")>,
  protocolReady: Promise<void>,
): Promise<void> {
  const loading = (async () => {
    const app = await loadContext({ fromInvocation: true });
    const { defaultPickerReleaseCheck } = await import("./picker");
    const releaseCheck = defaultPickerReleaseCheck();
    const entries = await listWorkflows(app.repoRoot, app.config);
    return { releaseCheck, app, entries };
  })();
  void loading.catch(() => {});

  await protocolReady;
  if (!process.stdin.isTTY || !process.stdout.isTTY) die("picker requires a tty");
  const picker = await pickerImport;
  const { releaseCheck, app, entries } = await loading;

  const code = await picker.runPickerSession({
    entries,
    repoRoot: app.repoRoot,
    config: app.config,
    ctx: app.ctx,
    checkLatestRelease: () => releaseCheck,
  });
  process.exit(code);
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("hwf")
    .description(manifest.description)
    .version(PRODUCT_VERSION)
    .addHelpText("after", `\nWorkflow format: ${WORKFLOW_FORMAT}`);

  program
    .command("run")
    .description("Run a workflow by name")
    .argument("<name>", "workflow name")
    .option("--input <name=value>", "workflow input (repeatable)", collectInput, {})
    .option("--launch-payload", "read launch payload JSON from stdin")
    .action(
      async (name: string, opts: { input?: Record<string, string>; launchPayload?: boolean }) => {
        await cmdRun(name, opts);
      },
    );

  program
    .command("init")
    .description("Write local or global plugin config")
    .option("--force", "overwrite existing config without prompting")
    .option("--global", "write global plugin config")
    .action(async (opts: { force?: boolean; global?: boolean }) => {
      await cmdInit(opts);
    });

  const workflow = program.command("workflow").description("Workflow maintenance commands");
  workflow
    .command("import")
    .description("Import a shared workflow bundle")
    .argument("<payload>", "base64 workflow bundle or import command")
    .addOption(new Option("--to <scope>", "repo or global destination").choices(["repo", "global"]))
    .option("-y, --yes", "skip interactive confirmation")
    .option("--force", "replace conflicting workflows")
    .action(
      async (payload: string, opts: { to?: "repo" | "global"; yes?: boolean; force?: boolean }) => {
        await cmdWorkflowImport(payload, opts);
      },
    );
  workflow
    .command("inspect")
    .description("Print workflow input metadata")
    .argument("<name>", "workflow name")
    .option("--input <name=value>", "select guarded input path (repeatable)", collectInput, {})
    .option("--resolve", "resolve active dynamic choices")
    .action(async (name: string, opts: { input?: Record<string, string>; resolve?: boolean }) => {
      await cmdWorkflowInspect(name, opts);
    });

  program
    .command("launch")
    .description("Open the workflow picker popup")
    .action(async () => {
      await cmdLaunch();
    });

  program
    .command("picker")
    .description("Run the picker TUI (plugin popup entrypoint)")
    .action(async () => {
      preferOnDiskOpentuiLib();
      const protocolReady = ensureHerdrProtocol();
      const pickerImport = import("./picker");
      void protocolReady.catch(() => {});
      void pickerImport.catch(() => {});
      await runPickerPopup(pickerImport, protocolReady);
    });

  program
    .command("web")
    .description("Start the browser workbench")
    .argument("[route]", "optional w=|share=|run=<uuid>|import|new route")
    .option("--port <integer>", "listen port", parsePort)
    .option("--no-open", "do not open a browser")
    .action(async (route: string | undefined, opts: { port?: number; open?: boolean }) => {
      await cmdWeb(route, opts);
    });

  program
    .command("update")
    .description("Update to the latest published GitHub Release via Herdr")
    .action(async () => {
      await runUpdate();
    });

  program
    .command("setup", { hidden: true })
    .description("Install PATH commands and picker keybindings")
    .action(() => {
      runSetup();
    });

  return program;
}

async function main(): Promise<void> {
  tolerateClosedStdio();
  const program = buildProgram();
  // Bare TTY → web. A root `.action()` disables implicit `help` and turns unknown
  // tokens into excess-argument errors, so keep subcommand dispatch stock.
  const args = process.argv.slice(2);
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    args.push("web");
  }
  await program.parseAsync(args, { from: "user" });
}

if (import.meta.main) {
  main().catch((error) => die(error instanceof Error ? error.message : String(error)));
}
