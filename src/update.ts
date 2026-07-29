import { chdir } from "node:process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../herdr-plugin.toml";
import { die } from "./herdr";
import {
  compareSemver,
  fetchLatestPublishedRelease,
  RELEASE_REPO,
  ReleaseCheckError,
  type FetchLatestOptions,
} from "./release-check";
import { resolvePluginRoot } from "./setup/paths";

export type PluginSourceInfo = {
  kind: "github" | "local" | "unregistered";
  owner?: string;
  repo?: string;
};

export type UpdateDeps = {
  fetchLatest?: (opts?: FetchLatestOptions) => Promise<{ version: string; tag: string }>;
  resolveSource?: () => Promise<PluginSourceInfo>;
  runInstall?: (args: string[], cwd: string) => Promise<number>;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  fail?: (message: string) => never;
  env?: NodeJS.ProcessEnv;
  embeddedVersion?: string;
  leaveDir?: (pluginRootPath: string, env: NodeJS.ProcessEnv) => string;
};

const INSTALL_ARGS = ["plugin", "install", RELEASE_REPO, "--yes"] as const;

/**
 * `hwf update` — check latest published release and delegate replacement to Herdr.
 * Must not import the picker module.
 */
export async function runUpdate(deps: UpdateDeps = {}): Promise<void> {
  const write = deps.write ?? ((t) => process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t) => process.stderr.write(t));
  const fail: (message: string) => never = deps.fail ?? die;
  const env = deps.env ?? process.env;
  const embedded = deps.embeddedVersion ?? String(manifest.version);
  const fetchLatest = deps.fetchLatest ?? fetchLatestPublishedRelease;
  const resolveSource = deps.resolveSource ?? resolvePluginSource;
  const runInstall = deps.runInstall ?? runHerdrInstall;
  const leaveDir = deps.leaveDir ?? leavePluginRoot;

  let latest: { version: string; tag: string };
  try {
    latest = await fetchLatest();
  } catch (error) {
    const msg = error instanceof ReleaseCheckError ? error.message : String(error);
    fail(`update check failed: ${msg}`);
  }

  if (compareSemver(embedded, latest.version) >= 0) {
    write(`already up to date (${embedded})\n`);
    return;
  }

  const source = await resolveSource();
  if (source.kind === "local") {
    fail(
      `refusing to update a linked development checkout — run bun run install:dev from the working tree instead`,
    );
  }
  if (source.kind === "unregistered") {
    fail(
      `this binary is not a Herdr-managed herdr-workflows install — run: herdr plugin install ${RELEASE_REPO}`,
    );
  }

  write(`updating ${embedded} → ${latest.version} via herdr plugin install ${RELEASE_REPO}\n`);
  const root = resolvePluginRoot(env);
  const cwd = leaveDir(root, env);
  const code = await runInstall([...INSTALL_ARGS], cwd);
  if (code !== 0) {
    writeErr(`herdr plugin install failed with exit ${code}\n`);
    process.exit(code);
  }
  write(`updated to ${latest.version}\n`);
}

export function leavePluginRoot(
  pluginRootPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [homedir(), tmpdir(), env.HOME].filter((p): p is string =>
    Boolean(p && p.length > 0),
  );
  const normalizedRoot = join(pluginRootPath);
  for (const candidate of candidates) {
    const abs = join(candidate);
    if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + "/")) {
      try {
        chdir(abs);
        return abs;
      } catch {
        // try next
      }
    }
  }
  // Last resort: parent of plugin root when it is not the filesystem root.
  const parent = join(pluginRootPath, "..");
  if (parent !== normalizedRoot) {
    chdir(parent);
    return parent;
  }
  throw new Error(`cannot leave HERDR_PLUGIN_ROOT ${pluginRootPath}`);
}

async function resolvePluginSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginSourceInfo> {
  const herdr = env.HERDR_BIN_PATH?.trim() || "herdr";
  const proc = Bun.spawn([herdr, "plugin", "list", "--json", "--plugin", "herdr-workflows"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    // Missing plugin / herdr unavailable → treat as unregistered for clear guidance.
    if (/not found|no such|unknown plugin/i.test(stdout + stderr)) {
      return { kind: "unregistered" };
    }
    throw new Error(`herdr plugin list failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  }
  return parsePluginListSource(stdout);
}

export function parsePluginListSource(jsonText: string): PluginSourceInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("herdr plugin list returned invalid JSON");
  }
  const plugin = findHerdrWorkflowsPlugin(parsed);
  if (!plugin) return { kind: "unregistered" };
  const source = plugin.source;
  if (!source || typeof source !== "object") return { kind: "local" };
  const kind = (source as { kind?: unknown }).kind;
  if (kind === "github") {
    const owner = str((source as { owner?: unknown }).owner);
    const repo = str((source as { repo?: unknown }).repo);
    return { kind: "github", owner, repo };
  }
  if (kind === "local" || kind === undefined) return { kind: "local" };
  return { kind: "local" };
}

/**
 * Herdr CLI `--json` prints `{ id, result: { type: "plugin_list", plugins: [...] } }`.
 * Offline/error envelopes and a bare `result` object are accepted for the same shape.
 */
function findHerdrWorkflowsPlugin(parsed: unknown): { source?: unknown } | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const result =
    obj.result && typeof obj.result === "object"
      ? (obj.result as Record<string, unknown>)
      : obj.type === "plugin_list"
        ? obj
        : undefined;
  if (!result || result.type !== "plugin_list" || !Array.isArray(result.plugins)) {
    return undefined;
  }
  for (const entry of result.plugins) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { plugin_id?: unknown }).plugin_id;
    if (id === "herdr-workflows") return entry as { source?: unknown };
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function runHerdrInstall(args: string[], cwd: string): Promise<number> {
  const herdr = process.env.HERDR_BIN_PATH?.trim() || "herdr";
  const proc = Bun.spawn([herdr, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });
  return proc.exited;
}
