import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateDir } from "../config";
import { RUN_UUID_PATTERN } from "../history/types";
import { canonicalRepoRoot } from "../history/store";
import {
  assertCredentialStoreSafe,
  assertPrivateCredentialFile,
  assertPrivateCredentialFileSync,
} from "../fs-private";
import { startWebServer, type WebServer } from "./server";

type EndpointRecord = {
  repoRoot: string;
  url: string;
  /**
   * Identity of the build serving this endpoint, absent when the owner had none to claim. An
   * adopting client compares it against its own, so a workbench never serves a build its caller
   * did not ask for. This is what keeps the invariant, not the owner noticing its own code change.
   */
  build?: string;
};

export type WorkbenchHandle = {
  url: string;
  owned: boolean;
  stop: () => void;
};

type EndpointLockHold = {
  base: string;
  token: string;
};

export type EnsureWorkbenchDeps = {
  start?: (opts: { repoRoot: string; port?: number }) => Promise<WebServer>;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  stateDir?: string;
  writeRecord?: (record: EndpointRecord, stateDir: string) => Promise<void>;
  now?: () => number;
  staleLockMs?: number;
  lockAttempts?: number;
  lockWaitMs?: number;
};

type AcquireLockHooks = {
  /** Invoked after a stale/dangling decision, before the atomic steal. Tests use this as a barrier. */
  beforeSteal?: (info: { kind: "owned" | "dangling" | "legacy"; token?: string }) => void;
};

const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 100;
const STALE_LOCK_MS = 10_000;

function endpointKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex");
}

function endpointsDir(stateDir: string): string {
  return join(stateDir, "web-endpoints");
}

export function endpointRecordPath(repoRoot: string, stateDir: string): string {
  return join(endpointsDir(stateDir), `${endpointKey(repoRoot)}.json`);
}

export function endpointLockPath(repoRoot: string, stateDir: string): string {
  return join(endpointsDir(stateDir), `${endpointKey(repoRoot)}.lock`);
}

function ownedLockPath(base: string, token: string): string {
  return `${base}.${token}`;
}

async function ensurePrivateDir(stateDir: string): Promise<void> {
  await assertCredentialStoreSafe(stateDir);
  await assertCredentialStoreSafe(endpointsDir(stateDir));
}

async function writePrivateFile(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  try {
    await assertPrivateCredentialFile(tmp);
    await rename(tmp, path);
    await assertPrivateCredentialFile(path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readEndpointRecord(
  repoRoot: string,
  stateDir: string = pluginStateDir(),
): Promise<EndpointRecord | undefined> {
  const path = endpointRecordPath(repoRoot, stateDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (typeof row.repoRoot !== "string" || typeof row.url !== "string") return undefined;
    if (!row.repoRoot || !row.url) return undefined;
    const build = typeof row.build === "string" && row.build ? row.build : undefined;
    return { repoRoot: row.repoRoot, url: row.url, ...(build ? { build } : {}) };
  } catch {
    return undefined;
  }
}

export async function writeEndpointRecord(
  record: EndpointRecord,
  stateDir: string = pluginStateDir(),
): Promise<void> {
  await ensurePrivateDir(stateDir);
  await writePrivateFile(endpointRecordPath(record.repoRoot, stateDir), JSON.stringify(record));
}

/** Drop the record only when it still names this owner's URL. Caller must hold the endpoint lock. */
function removeEndpointRecordIfUrl(repoRoot: string, stateDir: string, url: string): void {
  const path = endpointRecordPath(repoRoot, stateDir);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if ((parsed as { url?: unknown }).url !== url) return;
    rmSync(path, { force: true });
  } catch {
    // missing or unreadable — nothing this owner should clear
  }
}

export async function probeEndpoint(
  url: string,
  expectedRepoRoot: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token");
    if (!token) return false;
    const res = await fetchImpl(`${parsed.protocol}//${parsed.host}/api/state`, {
      headers: { "x-hwf-token": token },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { canonicalRepoRoot?: unknown };
    return data.canonicalRepoRoot === expectedRepoRoot;
  } catch {
    return false;
  }
}

function isStale(st: Stats, now: () => number, staleLockMs: number): boolean {
  return now() - st.mtimeMs >= staleLockMs;
}

function clearClaimIfToken(base: string, expectedToken: string): void {
  const trash = `${base}.reclaim.${randomUUID()}`;
  try {
    renameSync(base, trash);
  } catch {
    return;
  }
  try {
    if (readFileSync(trash, "utf8").trim() !== expectedToken) {
      try {
        renameSync(trash, base);
      } catch {
        rmSync(trash, { force: true });
      }
      return;
    }
  } catch {
    // unreadable stolen claim
  }
  rmSync(trash, { force: true });
}

/**
 * Atomically steal a stale claim. Contenders race on renaming the unique owned dir
 * (or the claim file when dangling); only one wins, so a successor claim cannot be
 * deleted by a loser still acting on the old token.
 */
function reclaimStaleClaimSync(
  base: string,
  now: () => number,
  staleLockMs: number,
  hooks?: AcquireLockHooks,
): boolean {
  let st: Stats;
  try {
    st = statSync(base);
  } catch {
    return false;
  }

  if (st.isDirectory()) {
    if (!isStale(st, now, staleLockMs)) return false;
    hooks?.beforeSteal?.({ kind: "legacy" });
    const trash = `${base}.reclaim.${randomUUID()}`;
    try {
      renameSync(base, trash);
    } catch {
      return false;
    }
    if (!isStale(statSync(trash), now, staleLockMs)) {
      try {
        renameSync(trash, base);
      } catch {
        rmSync(trash, { recursive: true, force: true });
      }
      return false;
    }
    rmSync(trash, { recursive: true, force: true });
    return true;
  }

  let oldToken: string;
  try {
    oldToken = readFileSync(base, "utf8").trim();
  } catch {
    return false;
  }
  if (!oldToken) return false;

  const owned = ownedLockPath(base, oldToken);
  let ownedSt: Stats | undefined;
  try {
    ownedSt = statSync(owned);
  } catch {
    ownedSt = undefined;
  }

  if (ownedSt && !isStale(ownedSt, now, staleLockMs)) return false;

  if (!ownedSt) {
    hooks?.beforeSteal?.({ kind: "dangling", token: oldToken });
    clearClaimIfToken(base, oldToken);
    return !existsClaim(base);
  }

  hooks?.beforeSteal?.({ kind: "owned", token: oldToken });
  const trashOwned = `${owned}.reclaim.${randomUUID()}`;
  try {
    renameSync(owned, trashOwned);
  } catch {
    return false;
  }

  if (!isStale(statSync(trashOwned), now, staleLockMs)) {
    try {
      renameSync(trashOwned, owned);
    } catch {
      rmSync(trashOwned, { recursive: true, force: true });
    }
    return false;
  }

  clearClaimIfToken(base, oldToken);
  rmSync(trashOwned, { recursive: true, force: true });
  return true;
}

function existsClaim(base: string): boolean {
  try {
    statSync(base);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim file at `base` stores token; unique dir at `base.<token>` is the only path release deletes.
 * Stale reclaim steals via rename of that unique owned dir so only one contender can clear the claim.
 */
export function acquireEndpointLockSync(
  base: string,
  now: () => number = Date.now,
  staleLockMs: number = STALE_LOCK_MS,
  hooks?: AcquireLockHooks,
): EndpointLockHold | undefined {
  const token = randomUUID();
  const mine = ownedLockPath(base, token);
  mkdirSync(mine);

  const tryClaim = (): boolean => {
    try {
      writeFileSync(base, token, { flag: "wx", mode: 0o600 });
      assertPrivateCredentialFileSync(base);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        try {
          rmSync(base, { force: true });
        } catch {
          /* best-effort */
        }
        throw error;
      }
      return false;
    }
  };

  if (tryClaim()) return { base, token };
  reclaimStaleClaimSync(base, now, staleLockMs, hooks);
  if (tryClaim()) return { base, token };

  rmSync(mine, { recursive: true, force: true });
  return undefined;
}

/** Deletes only this hold's unique owned directory — never the shared claim path. */
export function releaseEndpointLockSync(hold: EndpointLockHold): void {
  rmSync(ownedLockPath(hold.base, hold.token), { recursive: true, force: true });
}

function clearOwnedRecordUnderLock(
  repoRoot: string,
  stateDir: string,
  url: string,
  now: () => number,
  staleLockMs: number,
): void {
  const hold = acquireEndpointLockSync(endpointLockPath(repoRoot, stateDir), now, staleLockMs);
  if (!hold) return;
  try {
    removeEndpointRecordIfUrl(repoRoot, stateDir, url);
  } finally {
    releaseEndpointLockSync(hold);
  }
}

/**
 * Read-only liveness check — never deletes records. A record whose build differs from the caller's
 * is not adoptable however healthy it is: adopting it would serve code the caller did not ask for.
 */
async function probeLiveRecord(
  repoRoot: string,
  stateDir: string,
  fetchImpl: typeof globalThis.fetch,
  build: string | undefined,
): Promise<EndpointRecord | undefined> {
  const record = await readEndpointRecord(repoRoot, stateDir);
  if (!record) return undefined;
  if (record.repoRoot !== repoRoot) return undefined;
  if (record.build !== build) return undefined;
  if (!(await probeEndpoint(record.url, repoRoot, fetchImpl))) return undefined;
  return record;
}

/** Caller must hold the endpoint lock. Removes only a still-unusable record. */
async function discardUnusableRecord(
  repoRoot: string,
  stateDir: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  const record = await readEndpointRecord(repoRoot, stateDir);
  if (!record) return;
  if (record.repoRoot !== repoRoot) {
    await rm(endpointRecordPath(repoRoot, stateDir), { force: true });
    return;
  }
  if (await probeEndpoint(record.url, repoRoot, fetchImpl)) return;
  removeEndpointRecordIfUrl(repoRoot, stateDir, record.url);
}

/** An explicit --port is an instruction, so a live endpoint on another port is not a match. */
function servesPort(url: string, port: number | undefined): boolean {
  if (port === undefined) return true;
  try {
    return new URL(url).port === String(port);
  } catch {
    return false;
  }
}

export async function openWorkbench(
  opts: { repoRoot: string; port?: number; build?: string },
  deps: EnsureWorkbenchDeps = {},
): Promise<WorkbenchHandle> {
  const repoRoot = await canonicalRepoRoot(opts.repoRoot);
  const stateDir = deps.stateDir ?? pluginStateDir();
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = deps.start ?? startWebServer;
  const writeRecord = deps.writeRecord ?? writeEndpointRecord;
  const now = deps.now ?? Date.now;
  const staleLockMs = deps.staleLockMs ?? STALE_LOCK_MS;
  const lockAttempts = deps.lockAttempts ?? LOCK_ATTEMPTS;
  const lockWaitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
  const lockBase = endpointLockPath(repoRoot, stateDir);

  await ensurePrivateDir(stateDir);

  for (let attempt = 0; attempt < lockAttempts; attempt++) {
    const existing = await probeLiveRecord(repoRoot, stateDir, fetchImpl, opts.build);
    if (existing && servesPort(existing.url, opts.port)) {
      return { url: existing.url, owned: false, stop: () => undefined };
    }

    const hold = acquireEndpointLockSync(lockBase, now, staleLockMs);
    if (!hold) {
      await sleep(lockWaitMs);
      continue;
    }

    try {
      const again = await probeLiveRecord(repoRoot, stateDir, fetchImpl, opts.build);
      if (again && servesPort(again.url, opts.port)) {
        return { url: again.url, owned: false, stop: () => undefined };
      }

      if (!again) await discardUnusableRecord(repoRoot, stateDir, fetchImpl);

      const server = await start({ repoRoot, port: opts.port });
      const record: EndpointRecord = {
        repoRoot,
        url: server.url,
        ...(opts.build ? { build: opts.build } : {}),
      };
      try {
        await writeRecord(record, stateDir);
      } catch (error) {
        server.stop();
        throw error;
      }

      let stopped = false;
      const ownedUrl = server.url;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        server.stop();
        clearOwnedRecordUnderLock(repoRoot, stateDir, ownedUrl, now, staleLockMs);
      };
      return { url: server.url, owned: true, stop };
    } finally {
      releaseEndpointLockSync(hold);
    }
  }

  throw new Error("timed out waiting for repository workbench endpoint");
}

const SCOPED_ROUTE_RE = /^(w|share)=(repo|global):([a-z0-9][a-z0-9-_]*)$/;
const RUN_ROUTE_RE = new RegExp(`^run=(${RUN_UUID_PATTERN})$`, "i");

export type WebRoute =
  | { kind: "w" | "share"; scope: "repo" | "global"; name: string; hash: string }
  | { kind: "import"; hash: "import" }
  | { kind: "new"; hash: "new" }
  | { kind: "run"; id: string; hash: string };

export function parseWebRoute(raw: string): WebRoute | undefined {
  if (raw === "import") return { kind: "import", hash: "import" };
  if (raw === "new") return { kind: "new", hash: "new" };
  const run = RUN_ROUTE_RE.exec(raw);
  if (run) {
    const id = run[1]!.toLowerCase();
    return { kind: "run", id, hash: `run=${id}` };
  }
  if (raw.startsWith("run=")) return undefined;
  const m = SCOPED_ROUTE_RE.exec(raw);
  if (!m) return undefined;
  const kind = m[1] as "w" | "share";
  const scope = m[2] as "repo" | "global";
  const name = m[3]!;
  return { kind, scope, name, hash: `${kind}=${scope}:${name}` };
}

export function appendRouteHash(url: string, route: WebRoute | undefined): string {
  if (!route) return url;
  return `${url}#${route.hash}`;
}

export function runWorkbenchRoute(id: string): string {
  return `run=${id.toLowerCase()}`;
}
