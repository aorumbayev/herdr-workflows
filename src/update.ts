/** GitHub release check and managed-plugin update orchestration for `hwf update`. */

import { chdir } from "node:process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PRODUCT_VERSION } from "./context";

const RELEASE_REPO = "aorumbayev/herdr-workflows";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const DEFAULT_RELEASE_CHECK_TIMEOUT_MS = 8_000;

export type LatestRelease = {
  tag: string;
  version: string;
};

export class ReleaseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCheckError";
  }
}

/** Strict `v0.x.y` tag → bare `0.x.y` version. */
export function parseReleaseTag(tag: string): LatestRelease {
  const m = /^v(0\.\d+\.\d+)$/.exec(tag.trim());
  if (!m) {
    throw new ReleaseCheckError(
      `latest release tag is not a strict v0.x.y semver: ${JSON.stringify(tag)}`,
    );
  }
  return { tag: `v${m[1]}`, version: m[1]! };
}

/** Compare `0.x.y` versions. Negative when a < b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseParts(a);
  const pb = parseParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

function parseParts(version: string): [number, number, number] {
  const m = /^(0)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new ReleaseCheckError(`expected 0.x.y version, got ${JSON.stringify(version)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export type FetchLatestOptions = {
  timeoutMs?: number;
  url?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Fetch only the latest *published* GitHub Release (drafts are not `/releases/latest`).
 * Network/parse failures throw ReleaseCheckError.
 */
export async function checkForUpdate(opts: FetchLatestOptions = {}): Promise<LatestRelease> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELEASE_CHECK_TIMEOUT_MS;
  const url = opts.url ?? LATEST_RELEASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "herdr-workflows",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new ReleaseCheckError(`latest release request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { tag_name?: unknown; draft?: unknown };
    if (body.draft === true) {
      throw new ReleaseCheckError("latest release endpoint returned a draft");
    }
    if (typeof body.tag_name !== "string") {
      throw new ReleaseCheckError("latest release response missing tag_name");
    }
    return parseReleaseTag(body.tag_name);
  } catch (error) {
    if (error instanceof ReleaseCheckError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ReleaseCheckError(`latest release request timed out after ${timeoutMs}ms`);
    }
    throw new ReleaseCheckError(
      `latest release request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export type PluginSourceInfo = {
  kind: "github" | "local" | "unregistered";
  owner?: string;
  repo?: string;
};

export type UpdateDeps = {
  fetchLatest?: (opts?: FetchLatestOptions) => Promise<{ version: string; tag: string }>;
  runInstall?: (args: string[], cwd: string) => Promise<number>;
  pluginRoot?: string;
  beforeInstall?: (info: { from: string; to: string; repo: string }) => void;
};

export type UpdateResult =
  | { kind: "up_to_date"; current: string }
  | { kind: "refused_local" }
  | { kind: "refused_unregistered"; repo: string }
  | { kind: "updated"; from: string; to: string; repo: string }
  | { kind: "install_failed"; from: string; to: string; repo: string; code: number };

/**
 * Check latest release, protect local/unregistered installs, and replace via Herdr when newer.
 * Throws ReleaseCheckError on fetch/parse failure. Does not write to the terminal or exit.
 */
export async function updatePlugin(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const fetchLatest = deps.fetchLatest ?? checkForUpdate;
  const runInstall = deps.runInstall ?? runHerdrInstall;
  const latest = await fetchLatest();

  if (compareSemver(PRODUCT_VERSION, latest.version) >= 0) {
    return { kind: "up_to_date", current: PRODUCT_VERSION };
  }

  const source = await resolvePluginSource();
  if (source.kind === "local") return { kind: "refused_local" };
  if (source.kind === "unregistered") {
    return { kind: "refused_unregistered", repo: RELEASE_REPO };
  }

  const root = deps.pluginRoot ?? defaultPluginRoot();
  const cwd = leavePluginRoot(root);
  deps.beforeInstall?.({ from: PRODUCT_VERSION, to: latest.version, repo: RELEASE_REPO });
  const code = await runInstall(
    ["plugin", "install", RELEASE_REPO, "--ref", latest.tag, "--yes"],
    cwd,
  );
  if (code !== 0) {
    return {
      kind: "install_failed",
      from: PRODUCT_VERSION,
      to: latest.version,
      repo: RELEASE_REPO,
      code,
    };
  }
  return { kind: "updated", from: PRODUCT_VERSION, to: latest.version, repo: RELEASE_REPO };
}

function defaultPluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  const injected = env.HERDR_PLUGIN_ROOT?.trim();
  if (injected) return resolve(injected);
  return resolve(process.cwd());
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
