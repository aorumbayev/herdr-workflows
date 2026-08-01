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
import { CAPTURE_BYTE_LIMIT, CaptureLimitError, assertUnderCaptureCap } from "../context";
import {
  WORKFLOW_NAME_RULE,
  resolveWorkflowFile,
  workflowPath,
  parseRaw,
  referencedWorkflowChildren,
  WORKFLOW_NAME_RE,
  WorkflowLoadError,
  assertWorkflowName,
  analyzeRawWorkflow,
  formatSensitivityBanner,
  mergeSensitivity,
  sensitivityLabels,
  workflowDisplayTitle,
  type WorkflowSensitivity,
} from "./grammar";
import { withPinnedSchemaPointer } from "./inputs";

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
