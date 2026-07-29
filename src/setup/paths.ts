import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import manifest from "../../herdr-plugin.toml";

export const PRODUCT_VERSION: string = manifest.version;
export const OWNERSHIP_FILE = ".herdr-workflows-cli.json";

export function resolveBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_BIN_HOME?.trim()) return resolve(env.XDG_BIN_HOME.trim());
  return join(homedir(), ".local", "bin");
}

export function binDirOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
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
export function resolveManagedBinary(pluginRoot: string): string | undefined {
  const bare = join(pluginRoot, "bin", "herdr-workflows");
  if (existsSync(bare)) return bare;
  return undefined;
}

export function isEphemeralPluginRoot(pluginRoot: string): boolean {
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
