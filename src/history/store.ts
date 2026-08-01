import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateDir } from "../config";
import {
  assertCredentialStoreSafe,
  assertPrivateCredentialFile,
  CredentialStoreError,
} from "../fs-private";
import { filterSortLimit, normalizeRunUuid, toDetail, toListItem } from "./project";
import {
  RUN_HISTORY_HEARTBEAT_MS,
  RUN_HISTORY_RETENTION_BYTES,
  RUN_HISTORY_VERSION,
  isSnapshot,
  type HistoryClaimResult,
  type RunCurrentStep,
  type RunDetail,
  type RunListFilter,
  type RunListItem,
  type RunSnapshot,
  type RunStepRecord,
  type RunTerminalStatus,
  type RunWorkflowSource,
} from "./types";

/** Machine-readable launch acknowledgements on the observed stdout channel. */

export type HistoryAck =
  | { state: "claimed"; id: string }
  | { state: "unavailable"; id?: string }
  | { state: "rejected"; error: string; id?: string };

const ACK_RE = /^@hwf-history:(claimed|unavailable|rejected)(?:\s+(\S+))?(?:\s+(.*))?$/;

export function formatHistoryAck(ack: HistoryAck): string {
  if (ack.state === "claimed") return `@hwf-history:claimed ${ack.id}`;
  if (ack.state === "unavailable") {
    return ack.id ? `@hwf-history:unavailable ${ack.id}` : "@hwf-history:unavailable";
  }
  return ack.id
    ? `@hwf-history:rejected ${ack.id} ${ack.error}`
    : `@hwf-history:rejected ${ack.error}`;
}

export function parseHistoryAck(line: string): HistoryAck | undefined {
  const m = ACK_RE.exec(line.trim());
  if (!m) return undefined;
  const state = m[1] as HistoryAck["state"];
  const second = m[2];
  const rest = m[3];
  if (state === "claimed") {
    if (!second) return undefined;
    return { state, id: second.toLowerCase() };
  }
  if (state === "unavailable") {
    return { state, ...(second ? { id: second.toLowerCase() } : {}) };
  }
  if (second && rest) {
    return { state: "rejected", id: second.toLowerCase(), error: rest };
  }
  return { state: "rejected", error: second ?? rest ?? "launch rejected" };
}

/**
 * Soft canonicalization for display and Current-scope lookups when a checkout may
 * already be deleted. Falls back to the input path when realpath fails.
 */
export async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  try {
    return await realpath(repoRoot);
  } catch {
    return repoRoot;
  }
}

class HistoryUnavailableError extends Error {
  constructor(message = "run history storage is unavailable") {
    super(message);
    this.name = "HistoryUnavailableError";
  }
}

function historyUnavailable(error: unknown): HistoryUnavailableError | undefined {
  if (error instanceof HistoryUnavailableError) return error;
  if (error instanceof CredentialStoreError) {
    return new HistoryUnavailableError(error.message);
  }
  return undefined;
}

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginStateDir(env), "runs");
}

export function snapshotPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(runsDir(env), `${id}.json`);
}

/** Tighten only when already private-or-absent; never silently repair an unsafe mode. */
async function chmodIfPrivateOrNew(path: string, mode: number): Promise<void> {
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) return;
  } catch {
    /* missing — mkdir/write will create */
  }
  await chmod(path, mode);
}

/** History must not strip ACLs — permission mismatch surfaces as unavailable. */
const historyAclOpts = {
  chmodFn: chmodIfPrivateOrNew,
  stripAclFn: async () => undefined,
};

async function ensureRunsDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const state = pluginStateDir(env);
  await assertCredentialStoreSafe(state, historyAclOpts);
  const dir = runsDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertCredentialStoreSafe(dir, historyAclOpts);
  return dir;
}

export async function readSnapshot(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunSnapshot | undefined> {
  const normalized = normalizeRunUuid(id);
  if (!normalized) return undefined;
  try {
    await ensureRunsDir(env);
  } catch (error) {
    throw historyUnavailable(error) ?? error;
  }
  const path = snapshotPath(normalized, env);
  try {
    await assertPrivateCredentialFile(path, historyAclOpts);
  } catch (error) {
    const unavailable = historyUnavailable(error);
    if (unavailable) throw unavailable;
    return undefined;
  }
  try {
    const text = await Bun.file(path).text();
    const parsed: unknown = JSON.parse(text);
    if (!isSnapshot(parsed) || parsed.id !== normalized) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeSnapshotAtomic(
  snapshot: RunSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = await ensureRunsDir(env);
  const target = snapshotPath(snapshot.id, env);
  const tmp = join(dir, `.${snapshot.id}.${randomBytes(6).toString("hex")}.tmp`);
  const body = `${JSON.stringify(snapshot)}\n`;
  await writeFile(tmp, body, { mode: 0o600 });
  await assertPrivateCredentialFile(tmp, historyAclOpts);
  await rename(tmp, target);
  await assertPrivateCredentialFile(target, historyAclOpts);
}

async function listSnapshotFiles(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const dir = await ensureRunsDir(env);
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    return [];
  }
}

export async function loadAllSnapshots(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunSnapshot[]> {
  const out: RunSnapshot[] = [];
  for (const name of await listSnapshotFiles(env)) {
    const id = name.slice(0, -".json".length);
    try {
      const snapshot = await readSnapshot(id, env);
      if (snapshot) out.push(snapshot);
    } catch (error) {
      const unavailable = historyUnavailable(error);
      if (unavailable) throw unavailable;
      throw error;
    }
  }
  return out;
}

async function retentionCleanup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const terminals: { id: string; path: string; size: number; started: number }[] = [];
  let terminalBytes = 0;
  for (const name of await listSnapshotFiles(env)) {
    const id = name.slice(0, -".json".length);
    const path = snapshotPath(id, env);
    try {
      const st = await stat(path);
      const snapshot = await readSnapshot(id, env);
      if (!snapshot || snapshot.status === undefined) continue;
      terminals.push({
        id,
        path,
        size: st.size,
        started: Date.parse(snapshot.started_at) || 0,
      });
      terminalBytes += st.size;
    } catch {
      /* skip */
    }
  }
  if (terminalBytes <= RUN_HISTORY_RETENTION_BYTES) return;
  terminals.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id));
  while (terminalBytes > RUN_HISTORY_RETENTION_BYTES && terminals.length > 1) {
    const oldest = terminals.shift()!;
    try {
      await rm(oldest.path, { force: true });
      await writeFile(join(runsDir(env), `${oldest.id}.expired`), "", { mode: 0o600 }).catch(
        () => undefined,
      );
      terminalBytes -= oldest.size;
    } catch {
      /* skip */
    }
  }
}

export type ClaimMeta = {
  id?: string;
  workflow: string;
  title?: string;
  source: RunWorkflowSource;
  checkout_root: string;
  started_at?: string;
};

export class RunHistorySession {
  private snapshot: RunSnapshot | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private env: NodeJS.ProcessEnv;
  private available = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  get id(): string | undefined {
    return this.snapshot?.id;
  }

  get isAvailable(): boolean {
    return this.available && this.snapshot !== undefined;
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(op, op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async claim(meta: ClaimMeta): Promise<HistoryClaimResult> {
    const id = meta.id !== undefined ? normalizeRunUuid(meta.id) : randomUUID().toLowerCase();
    if (meta.id !== undefined && !id) {
      return { ok: false, state: "rejected", error: "run identity must be a complete UUID" };
    }
    const runId = id!;
    const started = meta.started_at ?? new Date().toISOString();
    let checkout_root: string;
    try {
      checkout_root = await realpath(meta.checkout_root);
    } catch {
      return { ok: true, state: "unavailable", id: runId };
    }
    const snapshot: RunSnapshot = {
      version: RUN_HISTORY_VERSION,
      id: runId,
      workflow: meta.workflow,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      source: meta.source,
      checkout_root,
      started_at: started,
      heartbeat_at: started,
      steps: [],
    };
    try {
      await ensureRunsDir(this.env);
      const path = snapshotPath(snapshot.id, this.env);
      try {
        await writeFile(path, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code: unknown }).code === "EEXIST"
        ) {
          return {
            ok: false,
            state: "rejected",
            error: `run identity '${snapshot.id}' is already claimed`,
            id: runId,
          };
        }
        throw error;
      }
      try {
        await assertPrivateCredentialFile(path, historyAclOpts);
      } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      this.snapshot = snapshot;
      this.available = true;
      this.startHeartbeat();
      await retentionCleanup(this.env).catch(() => undefined);
      return { ok: true, state: "claimed", id: runId };
    } catch {
      this.available = false;
      this.snapshot = undefined;
      return { ok: true, state: "unavailable", id: runId };
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => {
      void this.touch().catch(() => undefined);
    }, RUN_HISTORY_HEARTBEAT_MS);
    timer.unref?.();
    this.heartbeat = timer;
  }

  stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async persistUnlocked(): Promise<void> {
    if (!this.available || !this.snapshot) return;
    try {
      await writeSnapshotAtomic(this.snapshot, this.env);
    } catch {
      /* observability must not break a workflow run */
    }
  }

  private async mutateLive(patch: (snap: RunSnapshot) => RunSnapshot): Promise<void> {
    return this.enqueue(async () => {
      if (!this.available || !this.snapshot || this.snapshot.status !== undefined) return;
      this.snapshot = patch(this.snapshot);
      await this.persistUnlocked();
    });
  }

  async touch(): Promise<void> {
    return this.mutateLive((snap) => ({
      ...snap,
      heartbeat_at: new Date().toISOString(),
    }));
  }

  async setCurrentStep(step: RunCurrentStep): Promise<void> {
    return this.mutateLive((snap) => ({
      ...snap,
      current_step: step,
      heartbeat_at: new Date().toISOString(),
    }));
  }

  async recordStep(step: RunStepRecord): Promise<void> {
    return this.mutateLive((snap) => ({
      ...snap,
      current_step: undefined,
      steps: [...snap.steps, step],
      heartbeat_at: new Date().toISOString(),
    }));
  }

  async finalize(
    status: RunTerminalStatus,
    opts: { returns?: unknown; error?: string } = {},
  ): Promise<void> {
    this.stopHeartbeat();
    return this.enqueue(async () => {
      if (!this.available || !this.snapshot) return;
      const finished = new Date().toISOString();
      this.snapshot = {
        ...this.snapshot,
        current_step: undefined,
        status,
        finished_at: finished,
        heartbeat_at: finished,
        ...(opts.returns !== undefined ? { returns: opts.returns } : {}),
      };
      if (opts.error) {
        const hasExplanation = this.snapshot.steps.some((s) => s.explanation);
        if (!hasExplanation && this.snapshot.steps.length > 0) {
          const last = this.snapshot.steps[this.snapshot.steps.length - 1]!;
          this.snapshot.steps = [
            ...this.snapshot.steps.slice(0, -1),
            { ...last, explanation: opts.error },
          ];
        }
      }
      await this.persistUnlocked();
      await retentionCleanup(this.env).catch(() => undefined);
    });
  }

  /** Best-effort dispose without terminal status (caller already finalized or abandoned). */
  dispose(): void {
    this.stopHeartbeat();
  }
}

export async function listRunHistory(
  filter: RunListFilter = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  { ok: true; runs: RunListItem[]; checkout_roots: string[] } | { ok: false; unavailable: true }
> {
  try {
    await ensureRunsDir(env);
    const now = filter.now ?? Date.now();
    const snapshots = await loadAllSnapshots(env);
    const items: RunListItem[] = snapshots.map((s) => toListItem(s, now));
    const checkout_root =
      typeof filter.checkout_root === "string"
        ? await canonicalRepoRoot(filter.checkout_root)
        : filter.checkout_root;
    const runs = filterSortLimit(items, { ...filter, checkout_root, now });
    const checkout_roots = [...new Set(snapshots.map((s) => s.checkout_root))].sort();
    return { ok: true, runs, checkout_roots };
  } catch {
    return { ok: false, unavailable: true };
  }
}

export async function getRunDetail(
  id: string,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunDetail> {
  const env = opts.env ?? process.env;
  const normalized = normalizeRunUuid(id);
  if (!normalized) {
    return { kind: "invalid", message: "run link is not a complete UUID" };
  }
  try {
    await ensureRunsDir(env);
    const snapshot = await readSnapshot(normalized, env);
    if (!snapshot) {
      const expiredMarker = Bun.file(join(runsDir(env), `${normalized}.expired`));
      if (await expiredMarker.exists()) {
        return { kind: "expired", id: normalized, message: "run record expired" };
      }
      return { kind: "missing", id: normalized, message: "run record not found" };
    }
    return toDetail(snapshot, { now: opts.now });
  } catch {
    return { kind: "unavailable", id: normalized, message: "run history storage is unavailable" };
  }
}

export function allocateRunId(): string {
  return randomUUID().toLowerCase();
}
