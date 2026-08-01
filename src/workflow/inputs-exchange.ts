import { constants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertChildInputContract,
  assertWorkflowReferences,
  shellUsesInput,
  workflowChildNames,
} from "./validate";
import {
  CAPTURE_BYTE_LIMIT,
  CaptureLimitError,
  assertUnderCaptureCap,
  workflowSchemaUrl,
  globalConfigPath,
  noProfilesConfiguredMessage,
  profileNames,
  repoConfigPath,
  latest,
  loadConfig,
  type WorkflowsConfig,
} from "../context";
import {
  WORKFLOW_NAME_RULE,
  resolveWorkflowFile,
  workflowPath,
  parseRaw,
  referencedWorkflowChildren,
  WORKFLOW_NAME_RE,
  WorkflowLoadError,
  rawStepKeyOrder,
  assertWorkflowName,
  analyzeRawWorkflow,
  formatSensitivityBanner,
  mergeSensitivity,
  sensitivityLabels,
  workflowDisplayTitle,
  evaluateWhen,
  bail,
  parseWhenClause,
  workflowNeedsTranscript,
  workflowTemplateRefs,
  analyzeResolvedSensitivity,
  type RawStep,
  type RawWorkflowDoc,
  type WorkflowSensitivity,
  type DynamicChoice,
  type InputSpec,
  type LoadedWorkflow,
  type TemplateNamespace,
  type RawWorkflow,
  type RawInputValue,
  type RecoveryAction,
  type ReturnsSpec,
  type WorkflowListEntry,
  type WorkflowStep,
} from "./grammar";

const SCHEMA_POINTER_RE = /^#\s*yaml-language-server:\s*\$schema=\S+\s*$/;

export function schemaPointer(): string {
  return `# yaml-language-server: $schema=${workflowSchemaUrl()}`;
}

/**
 * Give workflow text a schema pointer for the contract this build implements. Any pointer already
 * present is replaced wherever it sits, so a file authored against another version cannot end up
 * carrying two contradictory pointers. Text already pinned is returned byte-identical.
 */
export function withPinnedSchemaPointer(text: string): string {
  const pointer = schemaPointer();
  if (text.length === 0) return `${pointer}\n`;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !SCHEMA_POINTER_RE.test(line));
  if (kept.length === lines.length - 1 && lines[0] === pointer) return text;
  return [pointer, ...kept].join("\n");
}

/** Heuristic: body looks like workflow YAML rather than a base64 bundle. */
export function looksLikeWorkflowYaml(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > CAPTURE_BYTE_LIMIT) return false;
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && !t.includes("\n") && t.length > 80) return false;
  return /^version:\s*v1alpha1\b/m.test(t) && /^steps:\s*(?:$|\[)/m.test(t);
}

const entrySchema = z
  .object({
    name: z.string().regex(WORKFLOW_NAME_RE, WORKFLOW_NAME_RULE),
    yaml: z.string().min(1, "yaml must be non-empty"),
  })
  .strict();

const bundleSchema = z
  .array(entrySchema)
  .min(1, "bundle must contain at least one workflow")
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate workflow name '${name}'`,
          path: [i, "name"],
        });
      }
      seen.add(name);
    }
  });

type WorkflowBundleEntry = z.infer<typeof entrySchema>;
export type WorkflowBundle = z.infer<typeof bundleSchema>;

/** gzip OS byte forced to Unix so macOS/Linux encode to the same paste payload. */
const GZIP_OS_UNIX = 3;

const IMPORT_COMMAND_RE = /^hwf\s+workflow\s+import\s+"([^"]+)"\s*$/;

export function encodePayload(entries: WorkflowBundle): string {
  const parsed = bundleSchema.safeParse(entries);
  if (!parsed.success) {
    throw new WorkflowLoadError(
      `cannot encode bundle: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const json = JSON.stringify(parsed.data);
  assertUnderCaptureCap("workflow bundle", json);
  const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(json)));
  gz[9] = GZIP_OS_UNIX;
  return Buffer.from(gz).toString("base64");
}

export function formatImportCommand(payload: string): string {
  return `hwf workflow import "${payload}"`;
}

/** Accept a raw encoded bundle or the exact generated import command. Never runs a shell. */
export function extractPayload(text: string): string {
  const trimmed = text.trim();
  const cmd = IMPORT_COMMAND_RE.exec(trimmed);
  if (cmd) return cmd[1]!;
  if (/^hwf\b/i.test(trimmed) || /^herdr-workflows\b/i.test(trimmed)) {
    throw new WorkflowLoadError('expected canonical command: hwf workflow import "<payload>"');
  }
  return trimmed;
}

function gunzipBounded(encoded: string): string {
  const compact = encoded.replace(/\s+/g, "");
  const encodedBytes = Buffer.byteLength(compact);
  if (encodedBytes > CAPTURE_BYTE_LIMIT) {
    throw new CaptureLimitError("workflow bundle", encodedBytes);
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(compact, "base64"), { maxOutputLength: CAPTURE_BYTE_LIMIT });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new CaptureLimitError("workflow bundle", CAPTURE_BYTE_LIMIT + 1);
    }
    throw new WorkflowLoadError("not an hwf workflow payload (expected base64 from the docs)");
  }
  if (raw.byteLength > CAPTURE_BYTE_LIMIT) {
    throw new CaptureLimitError("workflow bundle", raw.byteLength);
  }
  return raw.toString("utf8");
}

export function decodePayload(payload: string): WorkflowBundle {
  const json = gunzipBounded(extractPayload(payload));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorkflowLoadError("payload decoded but is not JSON");
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const row = parsed as Record<string, unknown>;
    if ("v" in row || ("name" in row && "body" in row)) {
      throw new WorkflowLoadError(
        "payload uses the removed single-workflow format; re-export as a workflow bundle",
      );
    }
  }
  const result = bundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkflowLoadError(
      `payload is not a shared workflow bundle: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

export type ExportedBundle = {
  entries: WorkflowBundleEntry[];
  provenance: { name: string; source: "repo" | "global" }[];
  payload: string;
  command: string;
};

/**
 * Exact selected source plus transitively referenced workflows (repo-first for children).
 * Provenance is for local display only — never encoded in the payload.
 */
export async function exportWorkflowBundle(opts: {
  name: string;
  scope: "repo" | "global";
  repoRoot: string;
}): Promise<ExportedBundle> {
  const entries: WorkflowBundleEntry[] = [];
  const provenance: { name: string; source: "repo" | "global" }[] = [];
  const seen = new Set<string>();

  const visit = async (
    name: string,
    exactScope: "repo" | "global" | undefined,
    stack: string[],
  ): Promise<void> => {
    if (stack.includes(name)) {
      throw new WorkflowLoadError(`workflow cycle: ${[...stack, name].join(" → ")}`);
    }
    if (seen.has(name)) return;

    let file: string;
    let source: "repo" | "global";
    if (exactScope) {
      file = workflowPath(exactScope, opts.repoRoot, name);
      source = exactScope;
      if (!(await Bun.file(file).exists())) {
        throw new WorkflowLoadError(`workflow '${name}' not found in ${exactScope}`);
      }
    } else {
      const resolved = await resolveWorkflowFile(name, opts.repoRoot);
      if (!resolved) {
        throw new WorkflowLoadError(
          `workflow '${name}' not found (via ${stack.join(" → ") || "entry"})`,
        );
      }
      file = resolved.file;
      source = resolved.source;
    }

    const yaml = await Bun.file(file).text();
    const raw = parseRaw(file, yaml);
    seen.add(name);
    entries.push({ name, yaml });
    provenance.push({ name, source });

    const nextStack = [...stack, name];
    for (const child of referencedWorkflowChildren(raw)) {
      await visit(child, undefined, nextStack);
    }
  };

  await visit(opts.name, opts.scope, []);
  const payload = encodePayload(entries);
  return {
    entries,
    provenance,
    payload,
    command: formatImportCommand(payload),
  };
}

const IND = "  ";
const ACTION_KEYS = new Set(["agent", "run", "herdr", "workflow", "params"]);
const SCHEMA_KEYS = new Set(rawStepKeyOrder);

function scalar(v: string): string {
  return Bun.YAML.stringify(v);
}

function blockSafe(v: string): boolean {
  return v.split("\n").every((ln) => ln === ln.trim() || ln === "");
}

function field(lines: string[], indent: string, key: string, v: string): void {
  if (v.includes("\n")) {
    if (!v.endsWith("\n") && blockSafe(v)) {
      lines.push(`${indent}${key}: |-`);
      for (const ln of v.split("\n")) lines.push(`${indent}${IND}${ln}`);
      return;
    }
    lines.push(`${indent}${key}: ${scalar(v)}`);
    return;
  }
  lines.push(`${indent}${key}: ${scalar(v)}`);
}

function dumpValue(lines: string[], indent: string, key: string, value: unknown): void {
  if (typeof value === "string") field(lines, indent, key, value);
  else if (value !== undefined) lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
}

function dumpActionLines(step: RawStep, indent: string): string[] {
  const m: string[] = [];
  if (typeof step.agent === "string") {
    field(m, indent, "agent", step.agent);
  } else if (typeof step.run === "string") {
    field(m, indent, "run", step.run);
  } else if (Array.isArray(step.run)) {
    m.push(`${indent}run: ${JSON.stringify(step.run)}`);
  } else if (typeof step.herdr === "string") {
    field(m, indent, "herdr", step.herdr);
    if (step.params && typeof step.params === "object") {
      m.push(`${indent}params: ${JSON.stringify(step.params)}`);
    }
  } else if (typeof step.workflow === "string") {
    field(m, indent, "workflow", step.workflow);
  } else {
    m.push(`${indent}run: ""`);
  }
  for (const key of rawStepKeyOrder) {
    if (ACTION_KEYS.has(key)) continue;
    const value = (step as Record<string, unknown>)[key];
    if (value !== undefined) dumpValue(m, indent, key, value);
  }
  for (const [key, value] of Object.entries(step)) {
    if (SCHEMA_KEYS.has(key) || value === undefined) continue;
    dumpValue(m, indent, key, value);
  }
  if (m.length === 0) m.push(`${indent}run: ""`);
  return m;
}

function dumpStep(step: RawStep): string[] {
  const I = IND + IND;
  const m = dumpActionLines(step, I);
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
}

/** `on_failure` is a mapping, not a list item. */
function dumpRecovery(step: RawStep): string[] {
  return dumpActionLines(step, IND);
}

function dumpInputs(lines: string[], inputs: NonNullable<RawWorkflowDoc["inputs"]>): void {
  lines.push("inputs:");
  for (const [name, inp] of Object.entries(inputs)) {
    if (typeof inp === "string") {
      lines.push(`${IND}${scalar(name)}: ${scalar(inp)}`);
      continue;
    }
    if (Array.isArray(inp)) {
      lines.push(`${IND}${scalar(name)}: ${JSON.stringify(inp)}`);
      continue;
    }
    lines.push(`${IND}${scalar(name)}:`);
    if (inp.type !== undefined) lines.push(`${IND}${IND}type: ${inp.type}`);
    if (inp.description !== undefined)
      lines.push(`${IND}${IND}description: ${scalar(inp.description)}`);
    if (inp.options !== undefined) {
      if (Array.isArray(inp.options)) {
        lines.push(`${IND}${IND}options:`);
        for (const o of inp.options) lines.push(`${IND}${IND}${IND}- ${scalar(o)}`);
      } else {
        lines.push(`${IND}${IND}options: ${JSON.stringify(inp.options)}`);
      }
    }
    if (inp.default !== undefined) lines.push(`${IND}${IND}default: ${scalar(inp.default)}`);
    if (inp.when !== undefined) lines.push(`${IND}${IND}when: ${JSON.stringify(inp.when)}`);
    if (inp.allow_custom !== undefined) {
      lines.push(`${IND}${IND}allow_custom: ${String(inp.allow_custom)}`);
    }
    if (inp.min_length !== undefined) lines.push(`${IND}${IND}min_length: ${inp.min_length}`);
  }
}

export function dumpWorkflow(doc: RawWorkflowDoc): string {
  const lines: string[] = [];
  lines.push(schemaPointer());
  lines.push(`version: ${scalar(doc.version)}`);
  if (doc.title) {
    field(lines, "", "title", doc.title);
  }
  if (doc.description) {
    field(lines, "", "description", doc.description);
  }
  if (doc.hidden === true) lines.push("hidden: true");
  if (doc.inputs && Object.keys(doc.inputs).length > 0) {
    lines.push("");
    dumpInputs(lines, doc.inputs);
  }
  if (doc.returns !== undefined) {
    lines.push("");
    if (typeof doc.returns === "string") field(lines, "", "returns", doc.returns);
    else lines.push(`returns: ${JSON.stringify(doc.returns)}`);
  }
  lines.push("");
  lines.push("steps:");
  doc.steps.forEach((step, i) => {
    if (i > 0) lines.push("");
    lines.push(...dumpStep(step));
  });
  if (doc.on_failure) {
    lines.push("");
    lines.push("on_failure:");
    lines.push(...dumpRecovery(doc.on_failure as RawStep));
  }
  return `${lines.join("\n")}\n`;
}

export type ImportScope = "repo" | "global";

export function parseImportScope(raw: string): ImportScope | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "r" || v === "repo" || v === "local" || v === "cwd") return "repo";
  if (v === "g" || v === "global" || v === "home") return "global";
  return undefined;
}

function scopeDir(scope: ImportScope, repoRoot: string, home: string): string {
  return scope === "repo" ? join(repoRoot, ".hwf", "workflows") : join(home, ".hwf", "workflows");
}

type BundlePreviewEntry = {
  name: string;
  yaml: string;
  title: string;
  warnings: string[];
};

export type BundlePreview = {
  entries: BundlePreviewEntry[];
  warnings: string[];
  unresolvedChildren: string[];
  banner: string;
  text: string;
};

function bundleFromRawYaml(yaml: string, name: string): WorkflowBundle {
  const n = assertWorkflowName(name);
  const body = yaml.trim();
  assertUnderCaptureCap("workflow yaml", body);
  parseRaw(`${n}.yaml`, body);
  return [{ name: n, yaml: body }];
}

/**
 * Schema-only check. Deliberately not the full load path: that resolves child workflows from disk.
 * Accepts a shared bundle/command, or raw workflow YAML when `name` is supplied.
 */
export function checkPayload(payload: string, opts?: { name?: string }): WorkflowBundle {
  const text = payload.trim();
  try {
    const bundle = decodePayload(text);
    for (const entry of bundle) {
      parseRaw(`${entry.name}.yaml`, entry.yaml);
    }
    return bundle;
  } catch (error) {
    if (!looksLikeWorkflowYaml(text)) throw error;
    const name = opts?.name;
    if (!name) {
      throw new WorkflowLoadError("raw YAML import requires a workflow name");
    }
    return bundleFromRawYaml(text, name);
  }
}

export function previewBundle(bundle: WorkflowBundle): BundlePreview {
  const names = new Set(bundle.map((e) => e.name));
  const aggregated: WorkflowSensitivity = {
    hasCommands: false,
    hasTranscript: false,
    sensitiveMethods: [],
    unresolvedChildren: [],
  };
  const entries: BundlePreviewEntry[] = [];

  for (const entry of bundle) {
    const raw = parseRaw(`${entry.name}.yaml`, entry.yaml);
    const local = analyzeRawWorkflow(raw);
    mergeSensitivity(aggregated, local);
    for (const child of referencedWorkflowChildren(raw)) {
      if (!names.has(child) && !aggregated.unresolvedChildren.includes(child)) {
        aggregated.unresolvedChildren.push(child);
      }
    }
    entries.push({
      name: entry.name,
      yaml: entry.yaml,
      title: workflowDisplayTitle(entry.name, raw.title),
      warnings: sensitivityLabels(local),
    });
  }
  aggregated.sensitiveMethods.sort();
  aggregated.unresolvedChildren.sort();

  const banner = formatSensitivityBanner(aggregated);
  const childNote =
    aggregated.unresolvedChildren.length > 0
      ? `Note: referenced workflows not in this bundle (${aggregated.unresolvedChildren.join(", ")}) will resolve from the importing repo (or be missing).\n`
      : "";

  const sections = entries.map((e) => {
    return `--- ${e.name}.yaml (${e.title}) ---\n${e.warnings.length ? `⚠ ${e.warnings.join(" · ")}\n` : ""}${e.yaml}\n`;
  });

  return {
    entries,
    warnings: sensitivityLabels(aggregated),
    unresolvedChildren: aggregated.unresolvedChildren,
    banner,
    text: `${banner}${childNote}${sections.join("\n")}`,
  };
}

export type ImportConflict = { name: string; path: string };

export type ImportWriteResult =
  | { status: "written"; results: { name: string; path: string }[] }
  | { status: "conflicts"; conflicts: ImportConflict[] };

export async function preflightConflicts(
  bundle: WorkflowBundle,
  dir: string,
): Promise<ImportConflict[]> {
  const conflicts: ImportConflict[] = [];
  for (const entry of bundle) {
    const path = join(dir, `${entry.name}.yaml`);
    if (await Bun.file(path).exists()) conflicts.push({ name: entry.name, path });
  }
  return conflicts;
}

/** Filesystems that reject hard links entirely (exFAT, some network and container mounts). */
const LINK_UNSUPPORTED = new Set(["EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EPERM", "EXDEV", "EMLINK"]);

function linkUnsupported(error: unknown): boolean {
  return LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "");
}

/**
 * `link` is the atomic create-if-absent primitive: EEXIST is how publication detects a conflict.
 * Where links are unsupported, fall back to `copyFile(..., COPYFILE_EXCL)` then unlink tmp —
 * same create-if-absent semantics without a TOCTOU overwrite window.
 */
export async function publishStaged(
  tmp: string,
  dest: string,
  linkImpl: typeof link = link,
): Promise<void> {
  try {
    await linkImpl(tmp, dest);
    await unlink(tmp);
    return;
  } catch (error) {
    if (!linkUnsupported(error)) throw error;
  }
  await copyFile(tmp, dest, constants.COPYFILE_EXCL);
  await unlink(tmp);
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
  } catch (error) {
    if (!linkUnsupported(error)) throw error;
    await copyFile(src, dest);
  }
}

type ImportJournal = {
  dest: string;
  staging: string;
  previous: string;
};

export function importJournalPath(dir: string): string {
  return `${dir}.import-journal`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJournal(dir: string): Promise<ImportJournal | undefined> {
  try {
    const raw = await Bun.file(importJournalPath(dir)).text();
    const parsed = JSON.parse(raw) as ImportJournal;
    if (
      typeof parsed?.dest !== "string" ||
      typeof parsed?.staging !== "string" ||
      typeof parsed?.previous !== "string"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

const JOURNAL_STALE_MS = 10_000;

async function journalIsStale(journalPath: string): Promise<boolean> {
  try {
    const st = await stat(journalPath);
    return Date.now() - st.mtimeMs >= JOURNAL_STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Finish or reverse an interrupted scope swap so the destination is wholly old or wholly new.
 * Chosen approach: stage the full post-import tree and rename the scope directory once —
 * per-file publish cannot compose into bundle atomicity across process death.
 *
 * A live import (dest intact, staging present, previous absent) is left alone unless `force`
 * or the journal is older than JOURNAL_STALE_MS — peers must not delete each other's staging.
 */
export async function recoverInterruptedImport(
  dir: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const journalPath = importJournalPath(dir);
  const journal = await readJournal(dir);
  if (!journal) {
    await rm(journalPath, { force: true }).catch(() => undefined);
    return;
  }

  const destExists = await pathExists(journal.dest);
  const stagingExists = await pathExists(journal.staging);
  const previousExists = await pathExists(journal.previous);

  if (destExists && stagingExists && !previousExists) {
    if (!opts.force && !(await journalIsStale(journalPath))) return;
    await rm(journal.staging, { recursive: true, force: true });
    await unlink(journalPath).catch(() => undefined);
    return;
  }

  if (!destExists && previousExists && stagingExists) {
    await rename(journal.staging, journal.dest);
    await rm(journal.previous, { recursive: true, force: true });
  } else if (destExists && previousExists) {
    await rm(journal.previous, { recursive: true, force: true });
    if (stagingExists) await rm(journal.staging, { recursive: true, force: true });
  } else if (!destExists && previousExists && !stagingExists) {
    await rename(journal.previous, journal.dest);
  } else {
    if (stagingExists) await rm(journal.staging, { recursive: true, force: true });
    if (previousExists && destExists) {
      await rm(journal.previous, { recursive: true, force: true });
    }
  }
  await unlink(journalPath).catch(() => undefined);
}

async function claimJournal(journal: ImportJournal): Promise<boolean> {
  try {
    await writeFile(importJournalPath(journal.dest), JSON.stringify(journal), {
      flag: "wx",
      encoding: "utf8",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function writeBundleAtomic(
  bundle: WorkflowBundle,
  dir: string,
  replaceAll: boolean,
  hooks?: {
    afterPublish?: (info: { name: string; path: string }) => void | Promise<void>;
    beforeSwap?: () => void | Promise<void>;
  },
): Promise<ImportWriteResult> {
  await mkdir(dirname(dir), { recursive: true });
  await recoverInterruptedImport(dir);

  const conflicts = await preflightConflicts(bundle, dir);
  if (conflicts.length > 0 && !replaceAll) {
    return { status: "conflicts", conflicts };
  }

  const id = randomUUID();
  const staging = `${dir}.${id}.staging`;
  const previous = `${dir}.${id}.prev`;
  const journal: ImportJournal = { dest: dir, staging, previous };

  if (!(await claimJournal(journal))) {
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(10);
      await recoverInterruptedImport(dir);
      if (!(await Bun.file(importJournalPath(dir)).exists())) break;
    }
    const again = await preflightConflicts(bundle, dir);
    if (again.length > 0 && !replaceAll) return { status: "conflicts", conflicts: again };
    if (!(await claimJournal(journal))) {
      throw new WorkflowLoadError(`import already in progress for ${dir}`);
    }
  }

  try {
    await mkdir(staging, { recursive: true });
    const bundleFiles = new Set(bundle.map((entry) => `${entry.name}.yaml`));

    if (await pathExists(dir)) {
      for (const name of await readdir(dir)) {
        if (name.startsWith(".")) continue;
        if (bundleFiles.has(name)) continue;
        await linkOrCopy(join(dir, name), join(staging, name));
      }
    }

    const results: { name: string; path: string }[] = [];
    for (const entry of bundle) {
      const stagedPath = join(staging, `${entry.name}.yaml`);
      const finalPath = join(dir, `${entry.name}.yaml`);
      await writeFile(stagedPath, withPinnedSchemaPointer(entry.yaml), "utf8");
      results.push({ name: entry.name, path: finalPath });
      if (hooks?.afterPublish) {
        await hooks.afterPublish({ name: entry.name, path: stagedPath });
      }
    }

    if (hooks?.beforeSwap) await hooks.beforeSwap();

    if (await pathExists(dir)) {
      await rename(dir, previous);
    }
    await rename(staging, dir);
    if (await pathExists(previous)) {
      await rm(previous, { recursive: true, force: true });
    }
    await unlink(importJournalPath(dir)).catch(() => undefined);
    return { status: "written", results };
  } catch (error) {
    await recoverInterruptedImport(dir, { force: true }).catch(() => undefined);
    if (await pathExists(staging)) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await unlink(importJournalPath(dir)).catch(() => undefined);
    throw error;
  }
}

export const IMPORT_DISCLAIMER = `This payload came from outside your machine. Imported workflows are
reviewed executable code: they run shell commands and agent prompts with your
permissions. Read every line below before you accept it. There is no sandbox.`;

export type ImportPrompts = {
  confirm: (preview: string) => Promise<boolean>;
  chooseScope: () => Promise<ImportScope>;
  confirmReplaceAll?: (conflicts: ImportConflict[]) => Promise<boolean>;
};

export async function runImport(
  payload: string,
  opts: {
    repoRoot: string;
    home?: string;
    scope?: ImportScope;
    force?: boolean;
    name?: string;
    prompts?: ImportPrompts;
    afterPublish?: (info: { name: string; path: string }) => void | Promise<void>;
    beforeSwap?: () => void | Promise<void>;
  },
): Promise<{ bundle: WorkflowBundle; result: ImportWriteResult; dir: string } | { aborted: true }> {
  const bundle = checkPayload(payload, { name: opts.name });
  const preview = previewBundle(bundle);
  if (opts.prompts && !(await opts.prompts.confirm(preview.text))) {
    return { aborted: true };
  }
  const scope = opts.scope ?? (await opts.prompts?.chooseScope());
  if (!scope) throw new WorkflowLoadError("no destination chosen (pass --to=repo|global)");
  const dir = scopeDir(scope, opts.repoRoot, opts.home ?? process.env.HOME ?? homedir());

  const conflicts = await preflightConflicts(bundle, dir);
  let replaceAll = opts.force === true;
  if (conflicts.length > 0 && !replaceAll) {
    if (opts.prompts?.confirmReplaceAll) {
      replaceAll = await opts.prompts.confirmReplaceAll(conflicts);
      if (!replaceAll) return { aborted: true };
    } else if (!opts.force) {
      return { bundle, result: { status: "conflicts", conflicts }, dir };
    }
  }

  return {
    bundle,
    result: await writeBundleAtomic(bundle, dir, replaceAll, {
      afterPublish: opts.afterPublish,
      beforeSwap: opts.beforeSwap,
    }),
    dir,
  };
}

export { evaluateWhen } from "./grammar";

const DYNAMIC_CHOICE_TIMEOUT_MS = 10_000;
const DYNAMIC_CHOICE_MAX = 1_000;
const STDERR_TAIL = 500;

export function parseDynamicChoiceStdout(stdout: string): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push(value);
  }
  return choices;
}

export async function resolveDynamicChoices(
  file: string,
  name: string,
  dynamic: DynamicChoice,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  for (const el of dynamic.run) {
    if (el.includes("{{")) {
      bail(file, undefined, `inputs.${name}.options.run`, "dynamic choice argv rejects templates");
    }
  }
  const { spawnCapture } = await import("../engine");
  let result: Awaited<ReturnType<typeof spawnCapture>>;
  try {
    result = await spawnCapture(dynamic.run, {
      cwd: repoRoot,
      env,
      timeoutMs: DYNAMIC_CHOICE_TIMEOUT_MS,
      maxCaptureBytes: { source: `inputs.${name} dynamic choice` },
    });
  } catch (error) {
    if (error instanceof CaptureLimitError) {
      bail(file, undefined, `inputs.${name}`, error.message);
    }
    throw error;
  }
  if (result.timedOut) {
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `dynamic choice failed: timed out after ${result.timeoutMs / 1000}s`,
    );
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-STDERR_TAIL) || `exit ${result.exitCode}`;
    bail(file, undefined, `inputs.${name}`, `dynamic choice failed: ${tail}`);
  }
  const choices = parseDynamicChoiceStdout(result.stdout);
  if (choices.length === 0) {
    bail(file, undefined, `inputs.${name}`, "dynamic choice produced no options");
  }
  if (choices.length > DYNAMIC_CHOICE_MAX) {
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `dynamic choice produced ${choices.length} options (limit ${DYNAMIC_CHOICE_MAX})`,
    );
  }
  return choices;
}

export type CollectedInputs =
  | { ok: true; values: Record<string, string>; domains: Record<string, string[]> }
  | { ok: false; error: string };

type ActivePrompt = {
  index: number;
  spec: InputSpec;
  options?: string[];
};

type CurrentPromptResult =
  | { status: "prompt"; prompt: ActivePrompt }
  | { status: "done" }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export type InputSession = {
  current(): Promise<CurrentPromptResult>;
  answer(value: string): { ok: true } | { ok: false; error: string };
  back(): boolean;
  result(): CollectedInputs;
  /** Headless driver: apply provided/default values through the session. */
  completeFromProvided(provided?: Record<string, string>): Promise<CollectedInputs>;
  cancelPending(): void;
  readonly values: Record<string, string>;
  readonly domains: Record<string, string[]>;
  readonly cursor: number;
};

export type CreateInputSessionOpts = {
  specs: InputSpec[];
  file: string;
  config: WorkflowsConfig;
  repoRoot: string;
  answers?: Record<string, string>;
  domains?: Record<string, string[]>;
  resolveDynamic?: boolean;
};

function optionsForSpec(spec: InputSpec, domains: Record<string, string[]>): string[] | undefined {
  if (domains[spec.name]) return domains[spec.name];
  if (spec.options) return spec.options;
  return undefined;
}

async function resolveActiveOptions(
  spec: InputSpec,
  opts: CreateInputSessionOpts,
  domains: Record<string, string[]>,
): Promise<{ ok: true; options?: string[]; cache?: boolean } | { ok: false; error: string }> {
  if (spec.type === "profile") {
    const profiles = profileNames(opts.config);
    if (profiles.length === 0) {
      return {
        ok: false,
        error: `input '${spec.name}': ${noProfilesConfiguredMessage(
          await globalConfigPath(),
          repoConfigPath(opts.repoRoot),
        )}`,
      };
    }
    return { ok: true, options: profiles };
  }
  if (spec.type !== "choice") return { ok: true };
  const existing = optionsForSpec(spec, domains);
  if (existing) return { ok: true, options: existing };
  if (!spec.dynamicOptions) {
    return { ok: false, error: `input '${spec.name}': choice produced no options` };
  }
  if (opts.resolveDynamic === false) {
    return {
      ok: false,
      error: `input '${spec.name}': missing launch payload domain snapshot`,
    };
  }
  try {
    const options = await resolveDynamicChoices(
      opts.file,
      spec.name,
      spec.dynamicOptions,
      opts.repoRoot,
    );
    return { ok: true, options, cache: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateActiveValue(
  spec: InputSpec,
  value: string,
  options: string[] | undefined,
): string | undefined {
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    return `input '${spec.name}' must be at least ${spec.minLength} characters`;
  }
  if (spec.type === "profile") {
    if (!options?.includes(value)) {
      return `input '${spec.name}' must be one of: ${(options ?? []).join(", ")}`;
    }
    return undefined;
  }
  if (spec.type === "choice" && options) {
    if (!spec.allowCustom && !options.includes(value)) {
      return `input '${spec.name}' must be one of: ${options.join(", ")}`;
    }
  }
  return undefined;
}

/** Next active input given answers collected so far. */
function nextActiveInput(
  specs: InputSpec[],
  values: Record<string, string>,
  fromIndex = 0,
): { index: number; spec: InputSpec } | undefined {
  const ns: TemplateNamespace = { inputs: values, steps: {}, context: {} };
  for (let i = fromIndex; i < specs.length; i++) {
    const spec = specs[i]!;
    if (evaluateWhen(spec.when, ns)) return { index: i, spec };
  }
  return undefined;
}

function previousActiveIndex(
  specs: InputSpec[],
  values: Record<string, string>,
  beforeIndex: number,
): number | undefined {
  const kept: Record<string, string> = {};
  let last: number | undefined;
  for (let i = 0; i < beforeIndex; i++) {
    const probe = nextActiveInput(specs, kept, i);
    if (!probe || probe.index !== i) continue;
    const spec = specs[i]!;
    if (Object.hasOwn(values, spec.name)) kept[spec.name] = values[spec.name]!;
    last = i;
  }
  return last;
}

function emptyOptionsError(spec: InputSpec): string {
  return spec.type === "profile"
    ? `input '${spec.name}': no profiles configured; run \`hwf init\` or \`hwf init --global\``
    : `input '${spec.name}': choice produced no options`;
}

export function createInputSession(opts: CreateInputSessionOpts): InputSession {
  const specs = opts.specs;
  const values: Record<string, string> = { ...(opts.answers ?? {}) };
  const domains: Record<string, string[]> = { ...(opts.domains ?? {}) };
  const suppliedDomains = new Set(Object.keys(opts.domains ?? {}));
  const usedDomains = new Set<string>();
  const resolveToken = latest();
  let cursor = 0;
  let pending: ActivePrompt | undefined;

  const session: InputSession = {
    get values() {
      return values;
    },
    get domains() {
      return domains;
    },
    get cursor() {
      return cursor;
    },
    cancelPending() {
      resolveToken.bump();
      pending = undefined;
    },
    back() {
      const prev = previousActiveIndex(specs, values, cursor);
      if (prev === undefined) return false;
      resolveToken.bump();
      for (const spec of specs.slice(prev + 1)) {
        delete values[spec.name];
        delete domains[spec.name];
      }
      cursor = prev;
      pending = undefined;
      return true;
    },
    answer(value: string) {
      if (!pending) return { ok: false, error: "no active input" };
      const err = validateActiveValue(pending.spec, value, pending.options);
      if (err) return { ok: false, error: err };
      for (const later of specs.slice(pending.index + 1)) {
        delete values[later.name];
        delete domains[later.name];
      }
      values[pending.spec.name] = value;
      cursor = pending.index + 1;
      pending = undefined;
      return { ok: true };
    },
    async current() {
      const token = resolveToken.begin();
      const next = nextActiveInput(specs, values, cursor);
      if (!next) return { status: "done" };
      cursor = next.index;
      if (Object.hasOwn(domains, next.spec.name)) usedDomains.add(next.spec.name);
      const resolved = await resolveActiveOptions(next.spec, opts, domains);
      if (!resolveToken.current(token)) return { status: "cancelled" };
      if (!resolved.ok) return { status: "error", error: resolved.error };
      if (resolved.options !== undefined && resolved.options.length === 0) {
        return { status: "error", error: emptyOptionsError(next.spec) };
      }
      if (resolved.cache && resolved.options) domains[next.spec.name] = resolved.options;
      if (Object.hasOwn(domains, next.spec.name)) usedDomains.add(next.spec.name);
      pending = { index: next.index, spec: next.spec, options: resolved.options };
      return { status: "prompt", prompt: pending };
    },
    result() {
      for (const name of suppliedDomains) {
        if (!usedDomains.has(name)) {
          return {
            ok: false,
            error: `launch payload domain '${name}' belongs to an inactive or non-dynamic input`,
          };
        }
      }
      if (nextActiveInput(specs, values, cursor)) {
        return { ok: false, error: "input collection is incomplete" };
      }
      return { ok: true, values: { ...values }, domains: { ...domains } };
    },
    async completeFromProvided(provided = {}) {
      const declared = new Set(specs.map((spec) => spec.name));
      for (const name of Object.keys(provided)) {
        if (!declared.has(name)) return { ok: false, error: `unknown input '${name}'` };
      }
      for (const name of Object.keys(opts.domains ?? {})) {
        const spec = specs.find((row) => row.name === name);
        if (!spec || spec.type !== "choice" || !spec.dynamicOptions) {
          return {
            ok: false,
            error: `launch payload domain '${name}' must name a declared dynamic choice input`,
          };
        }
      }

      for (;;) {
        const cur = await session.current();
        if (cur.status === "cancelled") return { ok: false, error: "input collection cancelled" };
        if (cur.status === "error") return { ok: false, error: cur.error };
        if (cur.status === "done") break;
        const name = cur.prompt.spec.name;
        const value = Object.hasOwn(provided, name) ? provided[name]! : cur.prompt.spec.default;
        if (value === undefined) {
          return { ok: false, error: `missing input '${name}' (--input ${name}=…)` };
        }
        const answered = session.answer(value);
        if (!answered.ok) return answered;
      }

      for (const name of Object.keys(provided)) {
        if (!Object.hasOwn(session.values, name)) {
          return {
            ok: false,
            error: `input '${name}' is inactive under current answers`,
          };
        }
      }

      return session.result();
    },
  };
  return session;
}

/** Engine entry: bind a loaded workflow and drive the session headlessly. */
export async function completeWorkflowInputs(
  workflow: LoadedWorkflow,
  opts: Omit<CreateInputSessionOpts, "specs" | "file"> & {
    provided?: Record<string, string>;
  },
): Promise<CollectedInputs> {
  const session = createInputSession({
    specs: workflow.inputs,
    file: workflow.file,
    config: opts.config,
    repoRoot: opts.repoRoot,
    ...(opts.answers !== undefined ? { answers: opts.answers } : {}),
    ...(opts.domains !== undefined ? { domains: opts.domains } : {}),
    ...(opts.resolveDynamic !== undefined ? { resolveDynamic: opts.resolveDynamic } : {}),
  });
  return session.completeFromProvided(opts.provided);
}

export { parseRaw, parseRawWithDoc, rawWorkflowSchema } from "./grammar";
export { workflowPath } from "./grammar";
export { buildTemplateNamespace, workflowTemplateRefs } from "./grammar";
export {
  analyzeResolvedSensitivity,
  analyzeYamlTree,
  sensitivityLabels,
  workflowDisplayTitle,
} from "./grammar";

const EMPTY_CONFIG: WorkflowsConfig = { profiles: {}, transcripts: {} };

function globalDir(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "workflows");
}
function repoDir(root: string): string {
  return join(root, ".hwf", "workflows");
}

async function yamlNames(dir: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const path of new Bun.Glob("*.yaml").scan({ cwd: dir })) {
      names.push(path.replace(/\.yaml$/, ""));
    }
    return names.sort();
  } catch {
    return [];
  }
}

async function collectWorkflowEntries(repoRoot: string): Promise<WorkflowListEntry[]> {
  const map = new Map<string, WorkflowListEntry>();
  for (const name of await yamlNames(globalDir())) {
    map.set(name, { name, source: "global", file: workflowPath("global", repoRoot, name) });
  }
  for (const name of await yamlNames(repoDir(repoRoot))) {
    map.set(name, { name, source: "repo", file: workflowPath("repo", repoRoot, name) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function inputIsUsed(
  name: string,
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
  inputs: InputSpec[] = [],
): boolean {
  const refs = workflowTemplateRefs(steps, returns, onFailure);
  if (refs.some((p) => p.root === "inputs" && p.segments[0] === name)) return true;
  for (const input of inputs) {
    for (const clause of input.when ?? []) {
      const parts = clause.path.split(".");
      if (parts[0] === "inputs" && parts[1] === name) return true;
    }
  }
  for (const step of steps) {
    if (step.action.kind === "run" && step.action.payload.form === "shell") {
      if (shellUsesInput(step.action.payload.command, name)) return true;
    }
  }
  if (onFailure?.kind === "run" && onFailure.payload.form === "shell") {
    if (shellUsesInput(onFailure.payload.command, name)) return true;
  }
  return false;
}

function resolveInput(file: string, name: string, raw: RawInputValue): InputSpec {
  if (raw === "text") return { name, type: "text" };
  if (raw === "profile") return { name, type: "profile" };
  if (Array.isArray(raw)) return { name, type: "choice", options: raw };
  const type = raw.type ?? (raw.options !== undefined ? "choice" : "text");
  const whenClauses =
    raw.when === undefined
      ? undefined
      : (Array.isArray(raw.when) ? raw.when : [raw.when]).map((clause, i) =>
          parseWhenClause(
            file,
            undefined,
            Array.isArray(raw.when) ? `inputs.${name}.when[${i}]` : `inputs.${name}.when`,
            clause,
          ),
        );
  const extras = {
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.default !== undefined ? { default: raw.default } : {}),
    ...(whenClauses !== undefined ? { when: whenClauses } : {}),
    ...(raw.allow_custom === true ? { allowCustom: true } : {}),
    ...(raw.min_length !== undefined ? { minLength: raw.min_length } : {}),
  };
  if (type === "choice") {
    if (!raw.options) {
      bail(file, undefined, `inputs.${name}`, "choice input requires options");
    }
    if (Array.isArray(raw.options)) {
      return { name, type: "choice", options: raw.options, ...extras };
    }
    return {
      name,
      type: "choice",
      dynamicOptions: raw.options as DynamicChoice,
      ...extras,
    };
  }
  return { name, type, ...extras };
}

function inputsOf(file: string, raw: RawWorkflow): InputSpec[] {
  return Object.entries(raw.inputs ?? {}).map(([name, value]) => resolveInput(file, name, value));
}

function assertInputsUsed(file: string, workflow: LoadedWorkflow): void {
  for (const input of workflow.inputs) {
    if (
      !inputIsUsed(
        input.name,
        workflow.steps,
        workflow.returns,
        workflow.onFailure,
        workflow.inputs,
      )
    ) {
      bail(file, undefined, `inputs.${input.name}`, "unused input");
    }
  }
}

function assertDefaultInOptions(file: string, input: InputSpec): void {
  if (input.default === undefined || input.options === undefined) return;
  if (input.allowCustom) return;
  if (!input.options.includes(input.default)) {
    bail(
      file,
      undefined,
      `inputs.${input.name}.default`,
      `default '${input.default}' is not in available values`,
    );
  }
}

function finalizeInputs(file: string, inputs: InputSpec[]): InputSpec[] {
  for (const input of inputs) {
    if (input.type === "choice") {
      if (input.options !== undefined && input.options.length === 0) {
        bail(file, undefined, `inputs.${input.name}`, "choice produced no options");
      }
      assertDefaultInOptions(file, input);
    }
  }
  return inputs;
}

function loadFromRaw(
  name: string,
  file: string,
  source: "repo" | "global",
  raw: RawWorkflow,
): LoadedWorkflow {
  const inputs = inputsOf(file, raw);
  return {
    name,
    file,
    version: raw.version,
    title: raw.title,
    description: raw.description,
    hidden: raw.hidden === true,
    steps: raw.steps,
    inputs,
    returns: raw.returns,
    onFailure: raw.onFailure,
    repoOwned: source === "repo",
    needsTranscript: workflowNeedsTranscript(raw.steps, raw.returns),
  };
}

type LoadScope = {
  repoRoot: string;
  config: WorkflowsConfig;
  stack: string[];
  cache: Map<string, LoadedWorkflow>;
};

async function loadChild(name: string, scope: LoadScope): Promise<LoadedWorkflow> {
  if (scope.stack.includes(name)) {
    throw new WorkflowLoadError(`workflow cycle: ${[...scope.stack, name].join(" → ")}`);
  }
  const cached = scope.cache.get(name);
  if (cached) return cached;
  const resolved = await resolveWorkflowFile(name, scope.repoRoot);
  if (!resolved) {
    throw new WorkflowLoadError(
      `workflow '${name}' not found (via ${scope.stack.join(" → ") || "entry"})`,
    );
  }
  const raw = parseRaw(resolved.file, await Bun.file(resolved.file).text());
  const workflow = loadFromRaw(name, resolved.file, resolved.source, raw);
  const loaded = await finalizeWorkflow(workflow, {
    ...scope,
    stack: [...scope.stack, name],
  });
  scope.cache.set(name, loaded);
  return loaded;
}

async function finalizeWorkflow(
  workflow: LoadedWorkflow,
  scope: LoadScope,
): Promise<LoadedWorkflow> {
  assertInputsUsed(workflow.file, workflow);
  const inputs = finalizeInputs(workflow.file, workflow.inputs);
  const withInputs = { ...workflow, inputs };

  const childReturnsById = new Map<string, ReturnsSpec | undefined>();
  const children = new Map<string, LoadedWorkflow>();
  for (const childName of workflowChildNames(withInputs)) {
    if (!children.has(childName)) {
      children.set(childName, await loadChild(childName, scope));
    }
  }
  for (let i = 0; i < withInputs.steps.length; i++) {
    const step = withInputs.steps[i]!;
    if (step.action.kind !== "workflow" || !step.id) continue;
    const child = children.get(step.action.name)!;
    childReturnsById.set(step.id, child.returns);
  }

  const parentInputs = withInputs.inputs;
  const profiles = new Set(profileNames(scope.config));
  const producers = assertWorkflowReferences(
    withInputs.file,
    withInputs,
    childReturnsById,
    profiles,
  );

  for (let i = 0; i < withInputs.steps.length; i++) {
    const step = withInputs.steps[i]!;
    if (step.action.kind !== "workflow") continue;
    const child = children.get(step.action.name)!;
    assertChildInputContract(
      withInputs.file,
      i + 1,
      step.action.inputs,
      child,
      producers,
      parentInputs,
      profiles,
      step.when ?? [],
    );
  }
  if (withInputs.onFailure?.kind === "workflow") {
    const child = children.get(withInputs.onFailure.name)!;
    assertChildInputContract(
      withInputs.file,
      undefined,
      withInputs.onFailure.inputs,
      child,
      producers,
      parentInputs,
      profiles,
    );
  }

  return withInputs;
}

export async function parseWorkflowText(
  name: string,
  yaml: string,
  config: WorkflowsConfig = EMPTY_CONFIG,
  repoRoot: string = process.cwd(),
  file = `${name}.yaml`,
): Promise<LoadedWorkflow> {
  const workflow = loadFromRaw(name, file, "repo", parseRaw(file, yaml));
  return finalizeWorkflow(workflow, {
    repoRoot,
    config,
    stack: [name],
    cache: new Map(),
  });
}

export async function loadWorkflow(
  name: string,
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<LoadedWorkflow> {
  const resolved = await resolveWorkflowFile(name, repoRoot);
  if (!resolved) throw new WorkflowLoadError(`workflow '${name}' not found`);
  return loadWorkflowEntry({ name, ...resolved }, repoRoot, config);
}

export async function loadWorkflowEntry(
  entry: WorkflowListEntry,
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<LoadedWorkflow> {
  if (!(await Bun.file(entry.file).exists())) {
    bail(entry.file, undefined, undefined, "file not found");
  }
  const cfg = config ?? (await loadConfig(repoRoot));
  const raw = parseRaw(entry.file, await Bun.file(entry.file).text());
  const workflow = loadFromRaw(entry.name, entry.file, entry.source, raw);
  return finalizeWorkflow(workflow, {
    repoRoot,
    config: cfg,
    stack: [entry.name],
    cache: new Map(),
  });
}

export async function listWorkflows(
  repoRoot: string,
  config?: WorkflowsConfig,
): Promise<WorkflowListEntry[]> {
  const cfg = config ?? (await loadConfig(repoRoot));
  const entries = await collectWorkflowEntries(repoRoot);
  for (const entry of entries) {
    try {
      const workflow = await loadWorkflowEntry(entry, repoRoot, cfg);
      entry.hidden = workflow.hidden;
      entry.title = workflow.title;
      entry.description = workflow.description;
      entry.inputs = workflow.inputs;
      entry.repoOwned = workflow.repoOwned;
      entry.dynamicOptions = workflow.inputs.some((input) => input.dynamicOptions !== undefined);
      const flags = await analyzeResolvedSensitivity(
        {
          name: workflow.name,
          steps: workflow.steps,
          returns: workflow.returns,
          onFailure: workflow.onFailure,
        },
        repoRoot,
      );
      entry.hasCommands = flags.hasCommands;
      entry.needsTranscript = flags.hasTranscript || workflow.needsTranscript;
      entry.sensitiveMethods = flags.sensitiveMethods;
      entry.unresolvedChildren = flags.unresolvedChildren;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return entries;
}
