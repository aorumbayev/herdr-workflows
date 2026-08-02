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
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  assertCredentialStoreSafe,
  assertPrivateCredentialFile,
  assertPrivateCredentialFileSync,
  globalConfigPath,
  loadConfig,
  parseConfigText,
  pluginStateDir,
  repoConfigPath,
  workflowSchemaUrl,
} from "./context";
import { HERDR_METHOD_BY_NAME } from "./herdr-methods.generated";
import {
  RUN_UUID_PATTERN,
  canonicalRepoRoot,
  listRuns,
  runDetail,
  type RunProjectedStatus,
  type RunWorkflowSource,
} from "./history";
import {
  checkPayload,
  exportWorkflowBundle,
  parseImportScope,
  preflightConflicts,
  previewBundle,
  runImport,
} from "./workflow/exchange";
import {
  analyzeYamlTree,
  dumpWorkflow,
  listWorkflows,
  parseRaw,
  parseRawWithDoc,
  parseWorkflowText,
  rawWorkflowSchema,
  sensitivityLabels,
  withPinnedSchemaPointer,
  workflowDisplayTitle,
  workflowPath,
} from "./workflow/inputs";
import { WORKFLOW_NAME_RE } from "./workflow/grammar";
// @ts-expect-error Bun text import embeds source; noncanonical path avoids named-import cache collision
// oxlint-disable-next-line import/default -- Bun text import embeds source; module has named exports only
import fieldModelSource from "./web/../web/field-model.ts" with { type: "text" };
import pageHtml from "./web/page.html" with { type: "text" };
import logoSvg from "../docs/assets/logo.svg" with { type: "text" };

const FIELD_MODEL_JS = new Bun.Transpiler({ loader: "ts" })
  .transformSync(fieldModelSource as string)
  .replace(/^export /gm, "");
const PAGE = (pageHtml as unknown as string).replace("/* __HWF_FIELD_MODEL__ */", FIELD_MODEL_JS);
if (!PAGE.includes("function addressesField")) {
  throw new Error("field model failed to inline into the workbench page");
}
const LOGO = logoSvg as unknown as string;
// Same call `scripts/generate-schema.ts` commits, so the served copy cannot go stale.
const WORKFLOW_JSON_SCHEMA = z.toJSONSchema(rawWorkflowSchema);
const METHOD_TABLE = [...HERDR_METHOD_BY_NAME.values()];

type Scope = "repo" | "global";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

/**
 * Claim `file` for `text` only if nothing is there yet. `wx` makes the guard and the
 * write one filesystem operation, so two concurrent claims cannot both win.
 * Returns the failure response, or `undefined` once the file is ours.
 */
async function claimFile(file: string, text: string, taken: string): Promise<Response | undefined> {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errCode(error) === "EEXIST") return json({ ok: false, error: taken }, 409);
    return json({ ok: false, error: errText(error) }, 500);
  }
}

function scopeOf(v: unknown): Scope | undefined {
  return v === "repo" || v === "global" ? v : undefined;
}

/**
 * Identity of the bytes an editor loaded. A save carries the token it was handed and may only
 * overwrite content that still hashes to it, so a writer the editor never saw — a second tab,
 * an import, a checkout — is never silently discarded.
 */
function contentToken(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

async function diskToken(file: string): Promise<string | undefined> {
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined);
  return text === undefined ? undefined : contentToken(text);
}

/** Trusted ancestor that must not be escaped via intermediate symlinks. */
function trustedWorkflowBase(scope: Scope, repoRoot: string): string {
  return scope === "repo" ? resolve(repoRoot) : resolve(process.env.HOME ?? homedir());
}

function pathInsideRoot(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}${sep}`);
}

async function existingFileMode(file: string): Promise<number> {
  try {
    const st = await lstat(file);
    if (!st.isSymbolicLink() && st.isFile()) return st.mode & 0o777;
  } catch {
    /* new file */
  }
  return 0o600;
}

/**
 * Refuse symlinked path components (including intermediate parents), symlinked
 * workflow roots/files, and any path that resolves outside the trusted base.
 */
async function refuseUnsafeWorkflowPath(
  file: string,
  trustedBase: string,
  label: string,
): Promise<Response | undefined> {
  const absBase = resolve(trustedBase);
  const absFile = resolve(file);
  const rel = relative(absBase, absFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return json({ ok: false, error: `refusing path outside workflow root for ${label}` }, 400);
  }
  let realBase: string;
  try {
    realBase = await realpath(absBase);
  } catch {
    realBase = absBase;
  }
  const segments = rel.split(sep).filter((s) => s.length > 0);
  let cur = absBase;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i]!);
    let st;
    try {
      st = await lstat(cur);
    } catch (error) {
      if (errCode(error) !== "ENOENT") return json({ ok: false, error: errText(error) }, 500);
      const realParent = await realpath(dirname(cur));
      if (!pathInsideRoot(realParent, realBase)) {
        return json({ ok: false, error: `refusing path outside workflow root for ${label}` }, 400);
      }
      // The first missing component proves every remaining descendant is also absent.
      // The caller creates the directory chain, then runs this check again before writing.
      return undefined;
    }
    if (st.isSymbolicLink()) {
      if (i === segments.length - 1) {
        return json({ ok: false, error: `refusing symlinked workflow '${label}'` }, 400);
      }
      if (segments[i] === "workflows") {
        return json({ ok: false, error: `refusing symlinked workflow root for ${label}` }, 400);
      }
      return json({ ok: false, error: `refusing symlinked path component for ${label}` }, 400);
    }
  }
  const realFile = await realpath(absFile);
  if (!pathInsideRoot(realFile, realBase)) {
    return json({ ok: false, error: `refusing path outside workflow root for ${label}` }, 400);
  }
}

/**
 * In-place compare-and-swap: exclusive adjacent claim, baseline recheck under the
 * claim, same-directory temp write, atomic rename. Concurrent same-baseline saves
 * cannot both succeed. Claim ownership is token-scoped so a stale owner cannot
 * clear a successor's claim.
 */
async function replaceInPlace(
  file: string,
  text: string,
  base: string | undefined,
  name: string,
  scope: Scope,
  trustedBase: string,
): Promise<Response> {
  const claim = `${file}.save`;
  const hold = acquireEndpointLockSync(claim);
  if (!hold) {
    return json({ ok: false, error: `'${name}' is being saved in ${scope}` }, 409);
  }
  const tmp = join(dirname(file), `.${name}.${randomUUID()}.tmp`);
  let published = false;
  try {
    const unsafe = await refuseUnsafeWorkflowPath(file, trustedBase, name);
    if (unsafe) return unsafe;
    const onDisk = await diskToken(file);
    if (onDisk !== base) {
      return json(
        {
          ok: false,
          stale: true,
          error:
            onDisk === undefined
              ? `'${name}' no longer exists in ${scope}; it changed since this buffer was loaded`
              : `'${name}' changed in ${scope} since this buffer was loaded — reload to see the current file before saving`,
        },
        409,
      );
    }
    const mode = await existingFileMode(file);
    try {
      await writeFile(tmp, text, { mode });
      const beforePublish = await refuseUnsafeWorkflowPath(file, trustedBase, name);
      if (beforePublish) {
        await rm(tmp, { force: true }).catch(() => undefined);
        return beforePublish;
      }
      await rename(tmp, file);
      published = true;
    } catch (error) {
      let stillThere = false;
      try {
        await rm(tmp, { force: true });
      } catch {
        stillThere = true;
      }
      if (!stillThere) {
        try {
          await lstat(tmp);
          stillThere = true;
        } catch {
          /* removed */
        }
      }
      if (stillThere) {
        return json(
          {
            ok: false,
            orphan: shortPath(tmp),
            error: `save failed — ${errText(error)}; temporary file left at ${shortPath(tmp)}`,
          },
          500,
        );
      }
      return json({ ok: false, error: errText(error) }, 500);
    }
    try {
      releaseEndpointLockSync(hold);
    } catch (error) {
      return json(
        {
          ok: false,
          orphan: shortPath(claim),
          error: published
            ? `saved '${name}' but could not release save claim at ${shortPath(claim)} — ${errText(error)}`
            : errText(error),
        },
        500,
      );
    }
    try {
      statSync(`${claim}.${hold.token}`);
      return json(
        {
          ok: false,
          orphan: shortPath(claim),
          error: `saved '${name}' but save claim at ${shortPath(claim)} still blocks later saves`,
        },
        500,
      );
    } catch {
      /* owned marker gone — claim is dangling and the next saver clears it */
    }
    return json({ ok: true, base: contentToken(text) });
  } finally {
    if (!published) {
      try {
        releaseEndpointLockSync(hold);
      } catch {
        /* best-effort on the failure path */
      }
    }
  }
}

/** Home-relative path for display (`~/…`). */
function shortPath(path: string): string {
  const home = process.env.HOME ?? homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** Accept the bound host and its `localhost` alias, with or without the port. */
function hostAllowed(value: string | null, port: number): boolean {
  if (!value) return false;
  const host = value.replace(/^https?:\/\//, "");
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === "127.0.0.1" ||
    host === "localhost"
  );
}

async function getState(repoRoot: string): Promise<Response> {
  const config = await loadConfig(repoRoot);
  const profiles = Object.keys(config.profiles).sort();
  const entries = await listWorkflows(repoRoot, config);
  const mapped = await Promise.all(
    entries.map(async (e) => {
      const flags = sensitivityLabels({
        hasCommands: e.hasCommands === true,
        hasTranscript: e.needsTranscript === true,
        sensitiveMethods: e.sensitiveMethods ?? [],
        unresolvedChildren: e.unresolvedChildren ?? [],
      });
      return {
        name: e.name,
        title: workflowDisplayTitle(e.name, e.title),
        description: e.description ?? "",
        source: e.source,
        provenance: e.source === "repo" ? "repo" : "global",
        valid: !e.error,
        hidden: e.hidden === true,
        flags,
        inRepo: await Bun.file(workflowPath("repo", repoRoot, e.name)).exists(),
        inGlobal: await Bun.file(workflowPath("global", repoRoot, e.name)).exists(),
      };
    }),
  );
  return json({
    repoRoot: shortPath(repoRoot),
    canonicalRepoRoot: repoRoot,
    profiles,
    entries: mapped,
    workflowSchemaUrl: workflowSchemaUrl(),
  });
}

function handleParse(body: Record<string, unknown>): Response {
  try {
    const text = String(body.text ?? "");
    const { doc } = parseRawWithDoc("buffer.yaml", text);
    return json({ ok: true, doc });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

function handleFormat(body: Record<string, unknown>): Response {
  try {
    const parsed = rawWorkflowSchema.safeParse(body.doc);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join("; "),
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }
    const text = dumpWorkflow(parsed.data);
    parseRaw("buffer.yaml", text);
    return json({ ok: true, text });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

async function sensitivityFlagsForText(
  name: string,
  text: string,
  repoRoot: string,
): Promise<string[]> {
  if (!text) return [];
  try {
    return sensitivityLabels(await analyzeYamlTree(`${name}.yaml`, text, name, repoRoot));
  } catch {
    return [];
  }
}

async function handleValidate(repoRoot: string, body: Record<string, unknown>): Promise<Response> {
  const name = String(body.name ?? "buffer");
  const text = String(body.text ?? "");
  const flags = await sensitivityFlagsForText(name, text, repoRoot);
  try {
    await parseWorkflowText(name, text, await loadConfig(repoRoot), repoRoot, `${name}.yaml`);
    return json({ ok: true, flags });
  } catch (error) {
    return json({ ok: false, error: errText(error), flags }, 400);
  }
}

async function resolveOpenWorkflow(
  repoRoot: string,
  checkoutRoot: string | undefined,
  workflow: string | undefined,
  source: RunWorkflowSource | undefined,
): Promise<{ name: string; source: RunWorkflowSource } | undefined> {
  if (!checkoutRoot || !workflow || !source) return undefined;
  if ((await canonicalRepoRoot(checkoutRoot)) !== (await canonicalRepoRoot(repoRoot))) {
    return undefined;
  }
  const config = await loadConfig(repoRoot);
  const entries = await listWorkflows(repoRoot, config);
  const match = entries.find((e) => e.name === workflow && e.source === source && !e.error);
  if (!match) return undefined;
  return { name: match.name, source: match.source };
}

const RUN_STATUS_VALUES = new Set<string>([
  "running",
  "stale",
  "succeeded",
  "failed",
  "interrupted",
  "starting",
]);

function parseRunStatuses(statusParam: string | null): RunProjectedStatus[] | undefined {
  if (!statusParam) return undefined;
  const statuses = statusParam
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is RunProjectedStatus => RUN_STATUS_VALUES.has(s));
  return statuses.length > 0 ? statuses : undefined;
}

async function handleRuns(repoRoot: string, url: URL): Promise<Response> {
  const location = url.searchParams.get("location");
  const text = url.searchParams.get("q") ?? url.searchParams.get("text") ?? undefined;
  let checkout_root: string | null | undefined = repoRoot;
  if (location === "all" || location === "*") checkout_root = null;
  else if (location !== null && location !== "" && location !== "current") {
    checkout_root = location;
  }
  const status = parseRunStatuses(url.searchParams.get("status"));
  const listed = await listRuns({
    checkout_root,
    ...(text !== undefined ? { text } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  if (!listed.ok) {
    return json({ ok: false, unavailable: true, runs: [], locations: [] }, 503);
  }
  const locations = [
    { id: "current", label: "Current", root: repoRoot },
    { id: "all", label: "All folders", root: null as string | null },
    ...listed.checkout_roots
      .filter((root) => root !== repoRoot)
      .map((root) => ({ id: root, label: root, root })),
  ];
  return json({ ok: true, runs: listed.runs, locations, checkout_root: repoRoot });
}

async function handleRunDetail(repoRoot: string, url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  const { detail, blocks } = await runDetail(id);
  if (detail.kind === "invalid") {
    return json({ ok: false, detail, blocks }, 400);
  }
  if (detail.kind === "unavailable") {
    return json({ ok: false, detail, blocks }, 503);
  }
  if (detail.kind !== "snapshot") {
    const status = detail.kind === "expired" ? 410 : 404;
    return json({ ok: false, detail, blocks }, status);
  }
  const open_workflow = await resolveOpenWorkflow(
    repoRoot,
    detail.checkout_root,
    detail.workflow,
    detail.source,
  );
  const enriched = { ...detail, ...(open_workflow ? { open_workflow } : {}) };
  return json({
    ok: true,
    detail: enriched,
    blocks,
  });
}

function requireNameScope(
  name: string,
  scope: Scope | undefined,
): { ok: true; scope: Scope } | { ok: false; response: Response } {
  if (!WORKFLOW_NAME_RE.test(name) || !scope)
    return { ok: false, response: json({ ok: false, error: "name and scope required" }, 400) };
  return { ok: true, scope };
}

/**
 * Finish a move: remove the source now that `claimed` holds the workflow. A source that will
 * not go away undoes the claim so nothing changed. If that undo also fails the caller is told
 * which copy was left behind, because it is what makes later saves collide.
 */
export async function dropSource(
  source: string,
  claimed: string,
  label: string,
): Promise<Response> {
  try {
    await Bun.file(source).delete();
  } catch (error) {
    if (errCode(error) === "ENOENT") return json({ ok: true });
    const kept = `'${label}' could not be removed — ${errText(error)}`;
    try {
      await rm(claimed, { force: true });
    } catch (rollbackError) {
      // The only failure that leaves a file behind, so say so: the caller's view of
      // what is on disk is now wrong.
      return json(
        {
          ok: false,
          orphan: shortPath(claimed),
          error: `${kept}; the copy at ${shortPath(claimed)} could not be undone — ${errText(rollbackError)}`,
        },
        500,
      );
    }
    return json({ ok: false, error: kept }, 500);
  }
  return json({ ok: true });
}

/**
 * Persist a workflow. `previous` is the path the editor loaded this buffer from: the same
 * path means an in-place edit, a different path — or no previous at all — means the destination
 * is being claimed, so it must be free. An in-place edit may only replace the content the buffer
 * was derived from, identified by `base`, under an exclusive adjacent claim with atomic rename.
 * A move claims the destination and drops the source in one request; a source that will not go
 * away undoes the claim, so the call either moves the workflow or changes nothing.
 */
async function writeWorkflow(
  repoRoot: string,
  name: string,
  scope: Scope,
  text: string,
  previous?: { name: string; scope: Scope },
  base?: string,
): Promise<Response> {
  if (!WORKFLOW_NAME_RE.test(name)) return json({ ok: false, error: "invalid workflow name" }, 400);
  const normalized = withPinnedSchemaPointer(text);
  try {
    await parseWorkflowText(name, normalized, await loadConfig(repoRoot), repoRoot, `${name}.yaml`);
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
  const file = workflowPath(scope, repoRoot, name);
  const trustedBase = trustedWorkflowBase(scope, repoRoot);
  const unsafe = await refuseUnsafeWorkflowPath(file, trustedBase, name);
  if (unsafe) return unsafe;
  const prev = previous ? workflowPath(previous.scope, repoRoot, previous.name) : undefined;
  if (previous && prev && prev !== file) {
    const prevUnsafe = await refuseUnsafeWorkflowPath(
      prev,
      trustedWorkflowBase(previous.scope, repoRoot),
      previous.name,
    );
    if (prevUnsafe) return prevUnsafe;
  }
  if (prev === file) {
    await mkdir(dirname(file), { recursive: true });
    const underClaim = await refuseUnsafeWorkflowPath(file, trustedBase, name);
    if (underClaim) return underClaim;
    return replaceInPlace(file, normalized, base, name, scope, trustedBase);
  }
  await mkdir(dirname(file), { recursive: true });
  const beforeClaim = await refuseUnsafeWorkflowPath(file, trustedBase, name);
  if (beforeClaim) return beforeClaim;
  const claimed = await claimFile(file, normalized, `'${name}' already exists in ${scope}`);
  if (claimed) return claimed;
  if (!previous) return json({ ok: true, base: contentToken(normalized) });
  return dropSource(workflowPath(previous.scope, repoRoot, previous.name), file, previous.name);
}

async function handleWorkflow(
  repoRoot: string,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response> {
  if (req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const checked = requireNameScope(name, scopeOf(url.searchParams.get("scope")));
    if (!checked.ok) return checked.response;
    const text = await Bun.file(workflowPath(checked.scope, repoRoot, name))
      .text()
      .catch(() => "");
    let valid = true;
    let error: string | undefined;
    if (text) {
      try {
        await parseWorkflowText(name, text, await loadConfig(repoRoot), repoRoot, `${name}.yaml`);
      } catch (e) {
        valid = false;
        error = errText(e);
      }
    }
    const flags = await sensitivityFlagsForText(name, text, repoRoot);
    return json({ text, valid, error, flags, base: text ? contentToken(text) : undefined });
  }
  if (req.method === "PUT") {
    const scope = scopeOf(body.scope);
    if (!scope) return json({ ok: false, error: "scope required" }, 400);
    const prevName = String(body.previousName ?? "");
    const prevScope = scopeOf(body.previousScope);
    let previous: { name: string; scope: Scope } | undefined;
    if (prevName !== "" || body.previousScope != null) {
      if (!WORKFLOW_NAME_RE.test(prevName) || !prevScope)
        return json({ ok: false, error: "previousName and previousScope required" }, 400);
      previous = { name: prevName, scope: prevScope };
    }
    return writeWorkflow(
      repoRoot,
      String(body.name ?? ""),
      scope,
      String(body.text ?? ""),
      previous,
      typeof body.base === "string" && body.base ? body.base : undefined,
    );
  }
  if (req.method === "DELETE") {
    const name = String(body.name ?? "");
    const checked = requireNameScope(name, scopeOf(body.scope));
    if (!checked.ok) return checked.response;
    try {
      await Bun.file(workflowPath(checked.scope, repoRoot, name)).delete();
    } catch (error) {
      if (errCode(error) !== "ENOENT") return json({ ok: false, error: errText(error) }, 500);
    }
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405 });
}

async function handleConfig(
  repoRoot: string,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response> {
  const scope = scopeOf(req.method === "GET" ? url.searchParams.get("scope") : body.scope);
  if (!scope) return json({ ok: false, error: "scope required" }, 400);
  const file = scope === "repo" ? repoConfigPath(repoRoot) : await globalConfigPath();
  if (req.method === "GET") {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    return json({ text });
  }
  if (req.method === "PUT") {
    const text = String(body.text ?? "");
    try {
      parseConfigText(file, text);
    } catch (error) {
      return json({ ok: false, error: errText(error) }, 400);
    }
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, text);
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405 });
}

async function handleShare(repoRoot: string, url: URL): Promise<Response> {
  const name = url.searchParams.get("name") ?? "";
  const checked = requireNameScope(name, scopeOf(url.searchParams.get("scope")));
  if (!checked.ok) return checked.response;
  try {
    const exported = await exportWorkflowBundle({
      name,
      scope: checked.scope,
      repoRoot,
    });
    return json({
      ok: true,
      command: exported.command,
      payload: exported.payload,
      entries: exported.entries.map((e) => ({ name: e.name, yaml: e.yaml })),
      provenance: exported.provenance,
    });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

function importName(body: Record<string, unknown>): string | undefined {
  return typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
}

async function handleImportPreview(
  repoRoot: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    const bundle = checkPayload(String(body.text ?? ""), { name: importName(body) });
    const preview = previewBundle(bundle);
    const home = process.env.HOME ?? homedir();
    const repoConflicts = await preflightConflicts(bundle, join(repoRoot, ".hwf", "workflows"));
    const globalConflicts = await preflightConflicts(bundle, join(home, ".hwf", "workflows"));
    return json({
      ok: true,
      entries: preview.entries,
      warnings: preview.warnings,
      unresolvedChildren: preview.unresolvedChildren,
      banner: preview.banner,
      availability: {
        repo: { conflicts: repoConflicts },
        global: { conflicts: globalConflicts },
      },
    });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

async function handleImportWrite(
  repoRoot: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const scope = scopeOf(body.scope) ?? parseImportScope(String(body.scope ?? ""));
  if (!scope) return json({ ok: false, error: "scope required" }, 400);
  const replaceAll = body.replaceAll === true || body.force === true;
  try {
    const outcome = await runImport(String(body.text ?? ""), {
      repoRoot,
      scope,
      force: replaceAll,
      name: importName(body),
    });
    if ("aborted" in outcome) return json({ ok: false, error: "aborted" }, 400);
    if (outcome.result.status === "conflicts") {
      return json(
        {
          ok: false,
          error: "existing workflows require replace-all confirmation",
          conflicts: outcome.result.conflicts,
        },
        409,
      );
    }
    return json({ ok: true, results: outcome.result.results });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

function createHandler(
  repoRoot: string,
  token: string,
  port: number,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (!hostAllowed(req.headers.get("host"), port))
        return new Response("forbidden", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin && !hostAllowed(origin, port)) return new Response("forbidden", { status: 403 });

      if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
        return new Response(LOGO, {
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
          },
        });
      }

      if (url.pathname === "/") {
        if (url.searchParams.get("token") !== token)
          return new Response("forbidden", { status: 403 });
        return new Response(PAGE.replace("__HWF_TOKEN__", token), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (req.headers.get("x-hwf-token") !== token)
        return new Response("forbidden", { status: 403 });

      const body =
        req.method === "GET"
          ? {}
          : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

      if (url.pathname === "/api/state") return getState(repoRoot);
      if (url.pathname === "/api/schema" && req.method === "GET") return json(WORKFLOW_JSON_SCHEMA);
      if (url.pathname === "/api/methods" && req.method === "GET")
        return json({ methods: METHOD_TABLE });
      if (url.pathname === "/api/workflow") return handleWorkflow(repoRoot, req, url, body);
      if (url.pathname === "/api/parse" && req.method === "POST") return handleParse(body);
      if (url.pathname === "/api/format" && req.method === "POST") return handleFormat(body);
      if (url.pathname === "/api/validate" && req.method === "POST")
        return handleValidate(repoRoot, body);
      if (url.pathname === "/api/config") return handleConfig(repoRoot, req, url, body);
      if (url.pathname === "/api/runs" && req.method === "GET") return handleRuns(repoRoot, url);
      if (url.pathname === "/api/run" && req.method === "GET")
        return handleRunDetail(repoRoot, url);
      if (url.pathname === "/api/share" && req.method === "GET") return handleShare(repoRoot, url);
      if (url.pathname === "/api/import/preview" && req.method === "POST")
        return handleImportPreview(repoRoot, body);
      if (url.pathname === "/api/import" && req.method === "POST")
        return handleImportWrite(repoRoot, body);
      return new Response("not found", { status: 404 });
    } catch (error) {
      return json({ ok: false, error: errText(error) }, 500);
    }
  };
}

export type WebServer = { url: string; token: string; stop: () => void };

export async function startWebServer(opts: {
  repoRoot: string;
  port?: number;
}): Promise<WebServer> {
  const token = crypto.randomUUID();
  let port = opts.port ?? 7317;
  for (;;) {
    try {
      const handler = createHandler(opts.repoRoot, token, port);
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
      const url = `http://127.0.0.1:${server.port}/?token=${token}`;
      return { url, token, stop: () => server.stop(true) };
    } catch (error) {
      if (opts.port === undefined && /EADDRINUSE|in use/i.test(errText(error))) {
        port += 1;
        continue;
      }
      throw error;
    }
  }
}

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
