import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { globalConfigPath, loadConfig, parseConfigText, repoConfigPath } from "../config";
import { readRunLog, recentRuns } from "../runlog";
import { exportWorkflowBundle } from "../workflow/export";
import {
  checkPayload,
  parseImportScope,
  preflightConflicts,
  previewBundle,
  runImport,
} from "../workflow/import";
import { listWorkflows, parseWorkflowText, workflowPath } from "../workflow/load";
import { parseRaw, rawWorkflowSchema, type RawStep, type RawWorkflowDoc } from "../workflow/parse";
import { analyzeYamlTree, sensitivityLabels, workflowDisplayTitle } from "../workflow/trust";
import pageHtml from "./page.html" with { type: "text" };

const PAGE = pageHtml as unknown as string;
const IND = "  ";
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

type Scope = "repo" | "global";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
    await writeFile(file, text, { flag: "wx" });
  } catch (error) {
    if (errCode(error) === "EEXIST") return json({ ok: false, error: taken }, 409);
    return json({ ok: false, error: errText(error) }, 500);
  }
}

function scopeOf(v: unknown): Scope | undefined {
  return v === "repo" || v === "global" ? v : undefined;
}

async function configOf(repoRoot: string) {
  return loadConfig(repoRoot);
}

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

const DUMPED_KEYS = new Set([
  "agent",
  "run",
  "herdr",
  "workflow",
  "id",
  "using",
  "target",
  "shell",
  "params",
  "inputs",
  "cwd",
  "env",
  "pane",
  "background",
  "ready_when",
  "timeout",
  "retry",
  "when",
  "continue_on_error",
]);

function dumpStep(step: RawStep): string[] {
  const m: string[] = [];
  const I = IND + IND;
  if (typeof step.agent === "string") {
    field(m, I, "agent", step.agent);
  } else if (typeof step.run === "string") {
    field(m, I, "run", step.run);
  } else if (Array.isArray(step.run)) {
    m.push(`${I}run: ${JSON.stringify(step.run)}`);
  } else if (typeof step.herdr === "string") {
    field(m, I, "herdr", step.herdr);
    if (step.params && typeof step.params === "object") {
      m.push(`${I}params: ${JSON.stringify(step.params)}`);
    }
  } else if (typeof step.workflow === "string") {
    field(m, I, "workflow", step.workflow);
  } else {
    m.push(`${I}run: ""`);
  }
  for (const [key, value] of Object.entries(step)) {
    if (DUMPED_KEYS.has(key) && !["agent", "run", "herdr", "workflow", "params"].includes(key)) {
      if (typeof value === "string") field(m, I, key, value);
      else if (value !== undefined) m.push(`${I}${key}: ${JSON.stringify(value)}`);
    } else if (!DUMPED_KEYS.has(key) && value !== undefined) {
      if (typeof value === "string") field(m, I, key, value);
      else m.push(`${I}${key}: ${JSON.stringify(value)}`);
    }
  }
  if (m.length === 0) m.push(`${I}run: ""`);
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
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
    // dumpStep emits a list item; on_failure is a mapping — drop the marker and one indent level.
    const recovery = dumpStep(doc.on_failure as RawStep).map((ln) =>
      ln.startsWith(`${IND}- `) ? `${IND}${ln.slice(IND.length + 2)}` : ln.slice(IND.length),
    );
    lines.push(...recovery);
  }
  return `${lines.join("\n")}\n`;
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
  const config = await configOf(repoRoot);
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
  });
}

function handleParse(body: Record<string, unknown>): Response {
  try {
    const text = String(body.text ?? "");
    parseRaw("buffer.yaml", text);
    let data: unknown;
    try {
      data = Bun.YAML.parse(text);
    } catch (error) {
      return json({ ok: false, error: errText(error) }, 400);
    }
    const parsed = rawWorkflowSchema.safeParse(data);
    if (!parsed.success) {
      return json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    return json({ ok: true, doc: parsed.data });
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

async function handleValidate(repoRoot: string, body: Record<string, unknown>): Promise<Response> {
  const name = String(body.name ?? "buffer");
  try {
    await parseWorkflowText(
      name,
      String(body.text ?? ""),
      await configOf(repoRoot),
      repoRoot,
      `${name}.yaml`,
    );
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

async function handleRuns(): Promise<Response> {
  return json({ runs: recentRuns(await readRunLog()) });
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
 * path means an in-place edit (overwrite), a different path — or no previous at all — means
 * the destination is being claimed, so it must be free. A move claims the destination and
 * drops the source in one request; a source that will not go away undoes the claim, so the
 * call either moves the workflow or changes nothing.
 */
async function writeWorkflow(
  repoRoot: string,
  name: string,
  scope: Scope,
  text: string,
  previous?: { name: string; scope: Scope },
): Promise<Response> {
  if (!WORKFLOW_NAME_RE.test(name)) return json({ ok: false, error: "invalid workflow name" }, 400);
  try {
    await parseWorkflowText(name, text, await configOf(repoRoot), repoRoot, `${name}.yaml`);
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
  const file = workflowPath(scope, repoRoot, name);
  const prev = previous ? workflowPath(previous.scope, repoRoot, previous.name) : undefined;
  if (prev === file) {
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, text);
    return json({ ok: true });
  }
  const claimed = await claimFile(file, text, `'${name}' already exists in ${scope}`);
  if (claimed) return claimed;
  if (!previous) return json({ ok: true });
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
        await parseWorkflowText(name, text, await configOf(repoRoot), repoRoot, `${name}.yaml`);
      } catch (e) {
        valid = false;
        error = errText(e);
      }
    }
    let flags: string[] = [];
    if (text) {
      try {
        flags = sensitivityLabels(await analyzeYamlTree(`${name}.yaml`, text, name, repoRoot));
      } catch {
        flags = [];
      }
    }
    return json({ text, valid, error, flags });
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

async function handlePromote(repoRoot: string, body: Record<string, unknown>): Promise<Response> {
  const name = String(body.name ?? "");
  const fromChecked = requireNameScope(name, scopeOf(body.from));
  if (!fromChecked.ok) return fromChecked.response;
  const toChecked = requireNameScope(name, scopeOf(body.to));
  if (!toChecked.ok) return toChecked.response;
  const src = Bun.file(workflowPath(fromChecked.scope, repoRoot, name));
  if (!(await src.exists())) return json({ ok: false, error: "source not found" }, 404);
  const dstPath = workflowPath(toChecked.scope, repoRoot, name);
  const text = await src.text();
  if (body.force !== true) {
    const claimed = await claimFile(
      dstPath,
      text,
      `'${name}' already exists in ${toChecked.scope}`,
    );
    return claimed ?? json({ ok: true });
  }
  await mkdir(dirname(dstPath), { recursive: true });
  await Bun.write(dstPath, text);
  return json({ ok: true });
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

async function handleImportPreview(
  repoRoot: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    const bundle = checkPayload(String(body.text ?? ""));
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

      if (url.pathname === "/") {
        if (url.searchParams.get("token") !== token)
          return new Response("forbidden", { status: 403 });
        return new Response(PAGE.replace("__HWF_TOKEN__", token), {
          headers: { "content-type": "text/html; charset=utf-8" },
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
      if (url.pathname === "/api/workflow") return handleWorkflow(repoRoot, req, url, body);
      if (url.pathname === "/api/parse" && req.method === "POST") return handleParse(body);
      if (url.pathname === "/api/format" && req.method === "POST") return handleFormat(body);
      if (url.pathname === "/api/validate" && req.method === "POST")
        return handleValidate(repoRoot, body);
      if (url.pathname === "/api/promote" && req.method === "POST")
        return handlePromote(repoRoot, body);
      if (url.pathname === "/api/config") return handleConfig(repoRoot, req, url, body);
      if (url.pathname === "/api/runs" && req.method === "GET") return handleRuns();
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
