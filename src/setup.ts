import { spawnSync } from "node:child_process";
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
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import manifest from "../herdr-plugin.toml";

export const PRODUCT_VERSION: string = manifest.version;
const OWNERSHIP_FILE = ".herdr-workflows-cli.json";

/**
 * Where the workflow contract this build implements is published. Pinned to the release tag for
 * `PRODUCT_VERSION`, because schemas diverge between versions: a pointer at a moving ref would
 * describe some other build's contract to the editor reading it.
 */
export function workflowSchemaUrl(): string {
  return `https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v${PRODUCT_VERSION}/docs/workflow.schema.json`;
}

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
