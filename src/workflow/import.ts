import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePayload, type WorkflowBundle } from "./payload";
import { parseRaw } from "./parse";
import {
  analyzeRawWorkflow,
  formatSensitivityBanner,
  mergeSensitivity,
  referencedWorkflowChildren,
  sensitivityLabels,
  workflowDisplayTitle,
  type WorkflowSensitivity,
} from "./trust";
import { WorkflowLoadError } from "./types";

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

/**
 * Schema-only check. Deliberately not the full load path: that resolves child workflows and
 * runs `options:` shell commands, which would execute the payload before the user consents.
 */
export function checkPayload(payload: string): WorkflowBundle {
  const bundle = decodePayload(payload);
  for (const entry of bundle) {
    parseRaw(`${entry.name}.yaml`, entry.yaml);
  }
  return bundle;
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

async function cleanupTemps(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
}

type PublishedLink = { path: string; dev: number; ino: number };

/** Unlink only if the path still names the inode this attempt published. */
async function rollbackPublished(published: PublishedLink[]): Promise<void> {
  for (const row of published) {
    try {
      const st = await stat(row.path);
      if (st.dev === row.dev && st.ino === row.ino) await unlink(row.path);
    } catch {
      // missing or replaced — leave successor alone
    }
  }
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

async function backupExisting(dest: string, backup: string): Promise<void> {
  try {
    await link(dest, backup);
  } catch (error) {
    if (!linkUnsupported(error)) throw error;
    await copyFile(dest, backup);
  }
}

type ReplaceSlot = {
  dest: string;
  backup: string | null;
  published: boolean;
};

/** Returns backup paths kept because restore rename failed. */
async function rollbackReplaceAll(slots: ReplaceSlot[]): Promise<string[]> {
  const preserved: string[] = [];
  for (const row of slots) {
    if (!row.published) continue;
    try {
      if (row.backup) {
        await rename(row.backup, row.dest);
        row.backup = null;
      } else {
        await unlink(row.dest);
      }
    } catch {
      if (row.backup) preserved.push(row.backup);
    }
  }
  return preserved;
}

async function writeBundleStaged(
  bundle: WorkflowBundle,
  dir: string,
  replaceAll: boolean,
  afterPublish?: (info: { name: string; path: string }) => void | Promise<void>,
): Promise<ImportWriteResult> {
  await mkdir(dir, { recursive: true });
  const conflicts = await preflightConflicts(bundle, dir);
  if (conflicts.length > 0 && !replaceAll) {
    return { status: "conflicts", conflicts };
  }

  const staged: { tmp: string; dest: string; name: string }[] = [];
  const published: PublishedLink[] = [];
  const replaceSlots: ReplaceSlot[] = [];
  try {
    for (const entry of bundle) {
      const dest = join(dir, `${entry.name}.yaml`);
      const tmp = join(dir, `.${entry.name}.yaml.${randomUUID()}.tmp`);
      await writeFile(tmp, entry.yaml, "utf8");
      staged.push({ tmp, dest, name: entry.name });
    }

    const results: { name: string; path: string }[] = [];
    if (replaceAll) {
      for (const row of staged) {
        if (await Bun.file(row.dest).exists()) {
          const backup = join(dir, `.${row.name}.yaml.${randomUUID()}.bak`);
          await backupExisting(row.dest, backup);
          replaceSlots.push({ dest: row.dest, backup, published: false });
        } else {
          replaceSlots.push({ dest: row.dest, backup: null, published: false });
        }
      }

      for (let i = 0; i < staged.length; i++) {
        const row = staged[i]!;
        const slot = replaceSlots[i]!;
        await rename(row.tmp, row.dest);
        slot.published = true;
        results.push({ name: row.name, path: row.dest });
        if (afterPublish) await afterPublish({ name: row.name, path: row.dest });
      }
      await cleanupTemps(replaceSlots.map((s) => s.backup).filter((b): b is string => !!b));
      return { status: "written", results };
    }

    for (const row of staged) {
      try {
        await publishStaged(row.tmp, row.dest);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          await rollbackPublished(published);
          await cleanupTemps(staged.map((s) => s.tmp));
          return { status: "conflicts", conflicts: [{ name: row.name, path: row.dest }] };
        }
        throw error;
      }
      const st = await stat(row.dest);
      published.push({ path: row.dest, dev: st.dev, ino: st.ino });
      results.push({ name: row.name, path: row.dest });
      if (afterPublish) await afterPublish({ name: row.name, path: row.dest });
    }
    return { status: "written", results };
  } catch (error) {
    const preservedBackups = await rollbackReplaceAll(replaceSlots);
    await rollbackPublished(published);
    const preserved = new Set(preservedBackups);
    await cleanupTemps([
      ...staged.map((s) => s.tmp),
      ...replaceSlots.map((s) => s.backup).filter((b): b is string => !!b && !preserved.has(b)),
    ]);
    if (preservedBackups.length > 0) {
      const note = `original backup preserved at ${preservedBackups.join(", ")}`;
      if (error instanceof Error) {
        error.message = `${error.message}; ${note}`;
        throw error;
      }
      throw new Error(`${String(error)}; ${note}`);
    }
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
    prompts?: ImportPrompts;
    afterPublish?: (info: { name: string; path: string }) => void | Promise<void>;
  },
): Promise<{ bundle: WorkflowBundle; result: ImportWriteResult; dir: string } | { aborted: true }> {
  const bundle = checkPayload(payload);
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
    result: await writeBundleStaged(bundle, dir, replaceAll, opts.afterPublish),
    dir,
  };
}
