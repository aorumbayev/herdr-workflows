import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertCredentialStoreSafe,
  assertPrivateCredentialFile,
  CredentialStoreError,
  pluginStateDir,
} from "./context";
import type { LoadedWorkflow, WorkflowStep } from "./workflow/grammar";

/** Versioned private run snapshot and allowlisted projections. */

const RUN_HISTORY_VERSION = 1 as const;
const RUN_HISTORY_HEARTBEAT_MS = 5_000;
export const RUN_HISTORY_STALE_MS = 15_000;
export const RUN_HISTORY_RETENTION_BYTES = 512_000;
const RUN_HISTORY_LIST_LIMIT = 40;
/** Persisted failure explanation cap — CLI errors stay full; detail projection stays bounded. */
const FAILURE_EXPLANATION_LIMIT = 500;

function boundFailureExplanation(text: string): string {
  return text.length > FAILURE_EXPLANATION_LIMIT
    ? `…${text.slice(-FAILURE_EXPLANATION_LIMIT)}`
    : text;
}

export const RUN_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_UUID_RE = new RegExp(`^${RUN_UUID_PATTERN}$`);

export type RunWorkflowSource = "repo" | "global";
type RunStepPhase = "main" | "recovery";
type RunActionKind = "agent" | "run" | "herdr" | "workflow";
export type RunStepOutcomeKind =
  | "succeeded"
  | "skipped"
  | "launched"
  | "failed_continued"
  | "failed"
  | "interrupted";

export type RunTerminalStatus = "succeeded" | "failed" | "interrupted";
export type RunProjectedStatus =
  | "running"
  | "stale"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "starting";

const isoTimestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)));

const failureFactSchema = z.object({
  action: z.enum(["agent", "run", "herdr", "workflow"]),
  exit_code: z.number().optional(),
  method: z.string().optional(),
  coordination: z.string().optional(),
  step_id: z.string().optional(),
});

const stepIdentitySchema = z
  .object({
    phase: z.enum(["main", "recovery"]),
    workflow: z.string().min(1),
    workflow_path: z.array(z.string()),
    ordinal: z.number().int().min(1),
    total: z.number().int().min(1),
    parent_ordinal: z.number().int().min(1).optional(),
    step_id: z.string().optional(),
    action: z.enum(["agent", "run", "herdr", "workflow"]),
    label: z.string(),
  })
  .refine((row) => row.ordinal <= row.total, { message: "ordinal exceeds total" })
  .superRefine((row, ctx) => {
    const nested = row.workflow_path.length > 1;
    if (nested && row.parent_ordinal === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "nested step requires parent_ordinal",
        path: ["parent_ordinal"],
      });
    }
    if (!nested && row.parent_ordinal !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "top-level step must omit parent_ordinal",
        path: ["parent_ordinal"],
      });
    }
  });

const runStepRecordSchema = stepIdentitySchema.and(
  z.object({
    started_at: isoTimestamp.optional(),
    finished_at: isoTimestamp,
    outcome: z.enum([
      "succeeded",
      "skipped",
      "launched",
      "failed_continued",
      "failed",
      "interrupted",
    ]),
    failure: failureFactSchema.optional(),
    explanation: z.string().optional(),
  }),
);

const runCurrentStepSchema = stepIdentitySchema.and(
  z.object({
    started_at: isoTimestamp,
  }),
);

const runSnapshotSchema = z
  .object({
    version: z.literal(RUN_HISTORY_VERSION),
    id: z.string().refine((id) => RUN_UUID_RE.test(id.trim().toLowerCase())),
    workflow: z.string().min(1),
    title: z.string().optional(),
    source: z.enum(["repo", "global"]),
    checkout_root: z.string().min(1),
    started_at: isoTimestamp,
    heartbeat_at: isoTimestamp,
    finished_at: isoTimestamp.optional(),
    current_step: runCurrentStepSchema.optional(),
    steps: z.array(runStepRecordSchema),
    status: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    returns: z.unknown().optional(),
  })
  .superRefine((row, ctx) => {
    const hasStatus = row.status !== undefined;
    const hasFinished = row.finished_at !== undefined;
    if (hasStatus) {
      if (!hasFinished) {
        ctx.addIssue({
          code: "custom",
          message: "terminal status requires finished_at",
          path: ["finished_at"],
        });
      }
      if (row.current_step !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "terminal status forbids current_step",
          path: ["current_step"],
        });
      }
    } else if (hasFinished) {
      ctx.addIssue({
        code: "custom",
        message: "finished_at requires status",
        path: ["status"],
      });
    }
  });

type RunFailureFact = z.infer<typeof failureFactSchema>;
export type RunStepRecord = z.infer<typeof runStepRecordSchema>;
export type RunCurrentStep = z.infer<typeof runCurrentStepSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

/** Structural guard for on-disk snapshots — reject before projection. */
export function isSnapshot(value: unknown): value is RunSnapshot {
  return runSnapshotSchema.safeParse(value).success;
}

export type RunListItem = {
  id: string;
  display_id: string;
  workflow: string;
  title?: string;
  source: RunWorkflowSource;
  checkout_root: string;
  status: RunProjectedStatus;
  started_at: string;
  finished_at?: string;
  elapsed_ms: number;
  progress?: { done: number; total: number };
  current_label?: string;
  /** Safe completed/active step labels for search — never explanations. */
  step_labels?: string[];
  failure?: RunFailureFact;
};

type RunDetailStep = Omit<RunStepRecord, "finished_at" | "outcome"> & {
  finished_at?: string;
  outcome?: RunStepOutcomeKind;
  active?: boolean;
};

export type RunDetail =
  | {
      kind: "snapshot";
      id: string;
      display_id: string;
      workflow: string;
      title?: string;
      source: RunWorkflowSource;
      checkout_root: string;
      status: RunProjectedStatus;
      started_at: string;
      finished_at?: string;
      heartbeat_at: string;
      elapsed_ms: number;
      current_step?: RunDetailStep;
      steps: RunDetailStep[];
      remaining?: number;
      failure_explanation?: string;
      open_workflow?: { name: string; source: RunWorkflowSource };
    }
  | { kind: "missing"; id: string; message: string }
  | { kind: "expired"; id: string; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; id?: string; message: string };

export type RunListFilter = {
  checkout_root?: string | null;
  text?: string;
  status?: RunProjectedStatus | RunProjectedStatus[];
  now?: number;
};

export type HistoryClaimResult =
  | { ok: true; state: "claimed"; id: string }
  | { ok: true; state: "unavailable"; id: string }
  | { ok: false; state: "rejected"; error: string; id?: string };

/** Machine-readable launch acknowledgements on the observed stdout channel. */

type HistoryAck =
  | { state: "claimed"; id: string }
  | { state: "unavailable"; id?: string }
  | { state: "rejected"; error: string; id?: string };

const ACK_RE = /^@hwf-history:(claimed|unavailable|rejected)(?:\s+(\S+))?(?:\s+(.*))?$/;

/** Encode an ack line — history-internal (recorder). */
function formatHistoryAck(ack: HistoryAck): string {
  if (ack.state === "claimed") return `@hwf-history:claimed ${ack.id}`;
  if (ack.state === "unavailable") {
    return ack.id ? `@hwf-history:unavailable ${ack.id}` : "@hwf-history:unavailable";
  }
  return ack.id
    ? `@hwf-history:rejected ${ack.id} ${ack.error}`
    : `@hwf-history:rejected ${ack.error}`;
}

/** Decode an ack line from the detached-run stdout channel. */
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

export function normalizeRunUuid(raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  return RUN_UUID_RE.test(id) ? id : undefined;
}

function displayRunId(id: string): string {
  return id.slice(0, 8);
}

/** History-internal projection — surfaces use `listRuns` / `runDetail`. */
export function projectStatus(snapshot: RunSnapshot, now: number = Date.now()): RunProjectedStatus {
  if (snapshot.status === "succeeded") return "succeeded";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.status === "interrupted") return "interrupted";
  const age = now - Date.parse(snapshot.heartbeat_at);
  if (!Number.isFinite(age) || age >= RUN_HISTORY_STALE_MS) return "stale";
  return "running";
}

function failureFactOf(steps: RunStepRecord[]): RunFailureFact | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (
      step.outcome === "failed" ||
      step.outcome === "failed_continued" ||
      step.outcome === "interrupted"
    ) {
      return step.failure;
    }
  }
  return undefined;
}

function progressOf(snapshot: RunSnapshot): { done: number; total: number } | undefined {
  const entry = snapshot.steps.filter(
    (s) => s.workflow === snapshot.workflow && s.phase === "main",
  );
  const totals = entry.map((s) => s.total);
  const total =
    snapshot.current_step?.workflow === snapshot.workflow
      ? snapshot.current_step.total
      : totals.length > 0
        ? Math.max(...totals)
        : undefined;
  if (total === undefined) return undefined;
  return { done: entry.length, total };
}

function elapsedMs(snapshot: RunSnapshot, status: RunProjectedStatus, now: number): number {
  const started = Date.parse(snapshot.started_at);
  const end =
    snapshot.finished_at !== undefined
      ? Date.parse(snapshot.finished_at)
      : status === "running" || status === "stale"
        ? now
        : started;
  return Math.max(0, end - started);
}

function identityFields(snapshot: RunSnapshot, status: RunProjectedStatus, now: number) {
  return {
    id: snapshot.id,
    display_id: displayRunId(snapshot.id),
    workflow: snapshot.workflow,
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
    source: snapshot.source,
    checkout_root: snapshot.checkout_root,
    status,
    started_at: snapshot.started_at,
    ...(snapshot.finished_at !== undefined ? { finished_at: snapshot.finished_at } : {}),
    elapsed_ms: elapsedMs(snapshot, status, now),
  };
}

/** History-internal projection — surfaces use `listRuns`. */
export function toListItem(snapshot: RunSnapshot, now: number = Date.now()): RunListItem {
  const status = projectStatus(snapshot, now);
  const progress = progressOf(snapshot);
  const failure = failureFactOf(snapshot.steps);
  const step_labels = [
    ...snapshot.steps.map((s) => s.label),
    ...(snapshot.current_step !== undefined ? [snapshot.current_step.label] : []),
  ];
  return {
    ...identityFields(snapshot, status, now),
    ...(progress !== undefined ? { progress } : {}),
    ...(snapshot.current_step !== undefined ? { current_label: snapshot.current_step.label } : {}),
    ...(step_labels.length > 0 ? { step_labels } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

function remainingCount(snapshot: RunSnapshot): number | undefined {
  if (snapshot.status === undefined) return undefined;
  if (snapshot.status === "succeeded") return undefined;
  const entryMain = snapshot.steps.filter(
    (s) => s.workflow === snapshot.workflow && s.phase === "main",
  );
  if (entryMain.length === 0) return undefined;
  const total = Math.max(...entryMain.map((s) => s.total));
  const remaining = total - entryMain.length;
  return remaining > 0 ? remaining : undefined;
}

function detailStepFromRecord(step: RunStepRecord): RunDetailStep {
  return { ...step };
}

function detailStepFromCurrent(step: NonNullable<RunSnapshot["current_step"]>): RunDetailStep {
  return { ...step, active: true };
}

function isNestedUnder(parentPath: string[], childPath: string[]): boolean {
  if (childPath.length <= parentPath.length) return false;
  return parentPath.every((part, i) => childPath[i] === part);
}

function belongsToWrapper(parent: RunDetailStep, child: RunDetailStep): boolean {
  if (child.phase === "recovery") return false;
  if (child.parent_ordinal === undefined) return false;
  if (child.parent_ordinal !== parent.ordinal) return false;
  return isNestedUnder(parent.workflow_path, child.workflow_path);
}

/** Parent workflow wrapper before nested children even when children were recorded first. */
function orderDetailSteps(steps: RunDetailStep[]): RunDetailStep[] {
  if (steps.length <= 1) return steps;
  const out: RunDetailStep[] = [];
  const used = new Set<number>();

  const emit = (index: number): void => {
    if (used.has(index)) return;
    used.add(index);
    const parent = steps[index]!;
    out.push(parent);
    // Ordinary preceding steps share the entry path — only workflow: wrappers own descendants.
    if (parent.action !== "workflow") return;
    const children = steps
      .map((step, i) => ({ step, i }))
      .filter(({ step, i }) => !used.has(i) && belongsToWrapper(parent, step))
      .sort((a, b) => {
        const depthDelta = a.step.workflow_path.length - b.step.workflow_path.length;
        if (depthDelta !== 0) return depthDelta;
        if (a.step.ordinal !== b.step.ordinal) return a.step.ordinal - b.step.ordinal;
        return a.i - b.i;
      });
    for (const child of children) {
      if (child.step.workflow_path.length === parent.workflow_path.length + 1) emit(child.i);
    }
    for (const child of children) emit(child.i);
  };

  const topLen = Math.min(...steps.map((s) => s.workflow_path.length));
  const tops = steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => step.workflow_path.length === topLen)
    .sort((a, b) => {
      if (a.step.ordinal !== b.step.ordinal) return a.step.ordinal - b.step.ordinal;
      return a.i - b.i;
    });
  for (const top of tops) emit(top.i);
  for (let i = 0; i < steps.length; i++) emit(i);
  return out;
}

/** History-internal projection — surfaces use `runDetail`. */
export function toDetail(snapshot: RunSnapshot, opts: { now?: number } = {}): RunDetail {
  const now = opts.now ?? Date.now();
  const status = projectStatus(snapshot, now);
  const steps = orderDetailSteps(snapshot.steps.map(detailStepFromRecord));
  const current =
    snapshot.current_step !== undefined ? detailStepFromCurrent(snapshot.current_step) : undefined;
  let failure_explanation: string | undefined;
  for (let i = snapshot.steps.length - 1; i >= 0; i--) {
    const step = snapshot.steps[i]!;
    if (step.explanation) {
      failure_explanation = step.explanation;
      break;
    }
  }
  const remaining = remainingCount(snapshot);
  return {
    kind: "snapshot",
    ...identityFields(snapshot, status, now),
    heartbeat_at: snapshot.heartbeat_at,
    ...(current !== undefined ? { current_step: current } : {}),
    steps,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(failure_explanation !== undefined ? { failure_explanation } : {}),
  };
}

function searchableText(item: RunListItem): string {
  const parts = [
    item.workflow,
    item.title ?? "",
    item.id,
    item.display_id,
    item.status,
    item.current_label ?? "",
    ...(item.step_labels ?? []),
    item.source,
    item.checkout_root,
    item.failure?.action ?? "",
    item.failure?.method ?? "",
    item.failure?.step_id ?? "",
    item.failure?.exit_code !== undefined ? String(item.failure.exit_code) : "",
    item.failure?.coordination ?? "",
  ];
  return parts.join("\n").toLowerCase();
}

function matchesListFilter(item: RunListItem, filter: RunListFilter): boolean {
  if (filter.checkout_root !== undefined) {
    if (filter.checkout_root === null) {
      /* All — no root predicate */
    } else if (item.checkout_root !== filter.checkout_root) {
      return false;
    }
  }
  if (filter.status !== undefined) {
    const want = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!want.includes(item.status)) return false;
  }
  const text = filter.text?.trim().toLowerCase();
  if (text && !searchableText(item).includes(text)) return false;
  return true;
}

function sortNewestFirst(items: RunListItem[]): RunListItem[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(a.started_at);
    const bt = Date.parse(b.started_at);
    if (bt !== at) return bt - at;
    return b.id.localeCompare(a.id);
  });
}

/** History-internal list filter — surfaces use `listRuns`. */
function filterSortLimit(items: RunListItem[], filter: RunListFilter = {}): RunListItem[] {
  const matched = items.filter((item) => matchesListFilter(item, filter));
  return sortNewestFirst(matched).slice(0, RUN_HISTORY_LIST_LIMIT);
}

export function statusLabel(status: RunProjectedStatus): string {
  if (status === "running") return "RUNNING";
  if (status === "stale") return "STALE";
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "failed") return "FAILED";
  if (status === "interrupted") return "INTERRUPTED";
  return "STARTING";
}

export type RunDetailBlock =
  | { kind: "head"; status: string; title: string; display_id: string; elapsed: string }
  | { kind: "note"; text: string }
  | {
      kind: "step";
      depth: number;
      ordinal: number;
      total: number;
      label: string;
      outcome: string;
      explanation?: string;
    }
  | { kind: "error"; text: string };

export function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? `${sec % 60}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? `${min % 60}m` : ""}`;
}

/** Synthetic snapshot for the picker between history claim and the first poll. */
export function optimisticRunningDetail(opts: {
  id: string;
  workflow: string;
  source: RunWorkflowSource;
  checkout_root: string;
}): Extract<RunDetail, { kind: "snapshot" }> {
  const now = new Date().toISOString();
  return {
    kind: "snapshot",
    id: opts.id,
    display_id: opts.id.slice(0, 8),
    workflow: opts.workflow,
    source: opts.source,
    checkout_root: opts.checkout_root,
    status: "running",
    started_at: now,
    heartbeat_at: now,
    elapsed_ms: 0,
    steps: [],
  };
}

/** History-internal presentation — surfaces consume `runDetail().blocks`. */
export function presentRunDetail(detail: RunDetail): RunDetailBlock[] {
  if (detail.kind === "invalid") {
    return [{ kind: "error", text: detail.message ?? "invalid run" }];
  }
  if (detail.kind === "missing") {
    return [{ kind: "error", text: detail.message ?? "run not found" }];
  }
  if (detail.kind === "expired") {
    return [{ kind: "error", text: detail.message ?? "run expired" }];
  }
  if (detail.kind === "unavailable") {
    return [{ kind: "error", text: detail.message ?? "history unavailable" }];
  }

  const blocks: RunDetailBlock[] = [];
  blocks.push({
    kind: "head",
    status: statusLabel(detail.status),
    title: detail.title || detail.workflow,
    display_id: detail.display_id,
    elapsed: formatElapsed(detail.elapsed_ms),
  });
  blocks.push({ kind: "note", text: detail.checkout_root });
  if (detail.status === "stale") {
    blocks.push({ kind: "note", text: "writer heartbeat stale — not a failure" });
  }
  const hasSteps = detail.steps.length > 0 || Boolean(detail.current_step?.active);
  const hasRemaining = detail.remaining !== undefined && detail.remaining > 0;
  const hasFailure =
    Boolean(detail.failure_explanation) && !detail.steps.some((s) => s.explanation);
  for (const step of detail.steps) {
    const depth = Math.max(0, step.workflow_path.length - 1);
    const outcome = step.outcome ?? (step.active ? "running" : "");
    blocks.push({
      kind: "step",
      depth,
      ordinal: step.ordinal,
      total: step.total,
      label: step.label,
      outcome,
      ...(step.explanation !== undefined ? { explanation: step.explanation } : {}),
    });
  }
  if (detail.current_step?.active) {
    const step = detail.current_step;
    blocks.push({
      kind: "step",
      depth: Math.max(0, step.workflow_path.length - 1),
      ordinal: step.ordinal,
      total: step.total,
      label: step.label,
      outcome: "running",
    });
  }
  if (hasRemaining) {
    blocks.push({
      kind: "note",
      text: `${detail.remaining} step${detail.remaining === 1 ? "" : "s"} not run`,
    });
  }
  if (hasFailure && detail.failure_explanation) {
    blocks.push({ kind: "error", text: detail.failure_explanation });
  }
  if (!hasSteps && !hasRemaining && !hasFailure) {
    blocks.push({ kind: "note", text: "no step outcomes yet" });
  }
  return blocks;
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

/** Tighten private-or-absent paths; empty loose dirs only when mode is 0700. Never repair files or non-empty unsafe modes. */
async function chmodIfPrivateOrNew(path: string, mode: number): Promise<void> {
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) {
      if (mode !== 0o700 || !st.isDirectory() || (await readdir(path)).length !== 0) return;
    }
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
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await assertPrivateCredentialFile(tmp, historyAclOpts);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
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

type ClaimMeta = {
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
            { ...last, explanation: boundFailureExplanation(opts.error) },
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

/** List projection for picker and workbench — surfaces consume `runs` as-is. */
export async function listRuns(
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

async function loadRunDetail(
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

export type PresentedRunDetail = {
  detail: RunDetail;
  blocks: RunDetailBlock[];
};

/** Attach presentation blocks to a detail value (disk load or optimistic). */
export function presentDetail(detail: RunDetail): PresentedRunDetail {
  return { detail, blocks: presentRunDetail(detail) };
}

/** Detail projection + presentation blocks — picker and workbench render `blocks` identically. */
export async function runDetail(
  id: string,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PresentedRunDetail> {
  return presentDetail(await loadRunDetail(id, opts));
}

export function allocateRunId(): string {
  return randomUUID().toLowerCase();
}

type RunFinalStatus = RunTerminalStatus;

/** Narrow outcome shape the recorder persists — avoids importing the engine context module. */
type RecorderOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
      details?: Record<string, unknown>;
      coordinationLost?: boolean;
    };

export type RunRecorder = {
  readonly runId: string;
  child(scope: { name: string; workflowPath: string[]; parentOrdinal?: number }): RunRecorder;
  stepStarted(
    step: WorkflowStep,
    ordinal: number,
    total: number,
    label: string,
    phase?: RunStepPhase,
  ): Promise<void>;
  stepFinished(
    step: WorkflowStep,
    ordinal: number,
    total: number,
    label: string,
    kind: RunStepOutcomeKind,
    outcome?: RecorderOutcome,
    phase?: RunStepPhase,
  ): Promise<void>;
  finished(status: RunFinalStatus, extras?: { returns?: unknown; error?: string }): Promise<void>;
  dispose(): void;
};

type RecorderScope = {
  name: string;
  workflowPath: string[];
  parentOrdinal?: number;
};

type SharedState = {
  finalized: boolean;
};

function failureFact(
  step: WorkflowStep,
  outcome: Extract<RecorderOutcome, { ok: false }>,
): RunFailureFact {
  const details = outcome.details ?? {};
  return {
    action: step.action.kind as RunActionKind,
    ...(typeof details.exit_code === "number" ? { exit_code: details.exit_code } : {}),
    ...(step.action.kind === "herdr" ? { method: step.action.method } : {}),
    ...(outcome.coordinationLost === true ? { coordination: "lost" } : {}),
    ...(step.id ? { step_id: step.id } : {}),
  };
}

function stepBase(
  scope: RecorderScope,
  step: WorkflowStep,
  ordinal: number,
  total: number,
  label: string,
  phase: RunStepPhase,
) {
  return {
    phase,
    workflow: scope.name,
    workflow_path: [...scope.workflowPath],
    ordinal,
    total,
    ...(scope.parentOrdinal !== undefined ? { parent_ordinal: scope.parentOrdinal } : {}),
    ...(step.id ? { step_id: step.id } : {}),
    action: step.action.kind as RunActionKind,
    label,
  };
}

function emitAck(onAck: ((line: string) => void) | undefined, line: string): void {
  try {
    onAck?.(line);
  } catch {
    /* observed channel best-effort */
  }
}

function makeRecorder(
  session: RunHistorySession | undefined,
  runId: string,
  scope: RecorderScope,
  state: SharedState,
): RunRecorder {
  return {
    runId,
    child(next) {
      return makeRecorder(session, runId, next, state);
    },
    async stepStarted(step, ordinal, total, label, phase = "main") {
      if (!session) return;
      await session.setCurrentStep({
        ...stepBase(scope, step, ordinal, total, label, phase),
        started_at: new Date().toISOString(),
      });
    },
    async stepFinished(step, ordinal, total, label, kind, outcome, phase = "main") {
      if (!session) return;
      const failed = outcome !== undefined && !outcome.ok;
      // Nested child steps already carry the explanation; wrapper records facts only.
      const explainFailure = failed && step.action.kind !== "workflow";
      await session.recordStep({
        ...stepBase(scope, step, ordinal, total, label, phase),
        finished_at: new Date().toISOString(),
        outcome: kind,
        ...(failed
          ? {
              failure: failureFact(step, outcome),
              ...(explainFailure ? { explanation: boundFailureExplanation(outcome.error) } : {}),
            }
          : {}),
      });
    },
    async finished(status, extras) {
      if (state.finalized) return;
      state.finalized = true;
      if (!session) return;
      await session.finalize(status, extras ?? {}).catch(() => undefined);
    },
    dispose() {
      session?.dispose();
    },
  };
}

export async function createRunRecorder(opts: {
  workflow: LoadedWorkflow;
  runId?: string;
  checkoutRoot: string;
  onAck?: (line: string) => void;
}): Promise<{ ok: false; error: string } | { ok: true; recorder: RunRecorder }> {
  const session = new RunHistorySession();
  const claim = await session.claim({
    ...(opts.runId !== undefined ? { id: opts.runId } : {}),
    workflow: opts.workflow.name,
    ...(opts.workflow.title !== undefined ? { title: opts.workflow.title } : {}),
    source: opts.workflow.repoOwned ? "repo" : "global",
    checkout_root: opts.checkoutRoot,
  });
  const scope: RecorderScope = {
    name: opts.workflow.name,
    workflowPath: [opts.workflow.name],
  };
  if (!claim.ok) {
    emitAck(
      opts.onAck,
      formatHistoryAck({
        state: "rejected",
        error: claim.error,
        ...(claim.id !== undefined ? { id: claim.id } : {}),
      }),
    );
    session.dispose();
    return { ok: false, error: claim.error };
  }
  if (claim.state === "unavailable") {
    emitAck(opts.onAck, formatHistoryAck({ state: "unavailable", id: claim.id }));
    session.dispose();
    return { ok: true, recorder: makeRecorder(undefined, claim.id, scope, { finalized: false }) };
  }
  emitAck(opts.onAck, formatHistoryAck({ state: "claimed", id: claim.id }));
  return {
    ok: true,
    recorder: makeRecorder(session, claim.id, scope, { finalized: false }),
  };
}
