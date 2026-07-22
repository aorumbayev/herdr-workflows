import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { globalConfigPath, loadConfig, parseConfigText, repoConfigPath } from "../config";
import { readRunLog, recentRuns } from "../runlog";
import { listWorkflows, parseRaw, parseWorkflowText, workflowPath } from "../workflows";
import { dumpWorkflow } from "./yaml-build";
import pageHtml from "./page.html" with { type: "text" };

const PAGE = pageHtml as unknown as string;

const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;
type Scope = "repo" | "global";

/** Home-relative path for display, matching the manage TUI's `~/…` convention. */
function shortPath(path: string): string {
  const home = process.env.HOME ?? homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function scopeOf(v: unknown): Scope | undefined {
  return v === "repo" || v === "global" ? v : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function createHandler(
  repoRoot: string,
  token: string,
  port: number,
): (req: Request) => Promise<Response> {
  const configPath = (scope: Scope) =>
    scope === "repo" ? repoConfigPath(repoRoot) : globalConfigPath();

  async function writeWorkflow(name: string, scope: Scope, text: string): Promise<Response> {
    if (!WORKFLOW_NAME_RE.test(name)) return json({ ok: false, error: "invalid workflow name" }, 400);
    try {
      const agents = Object.keys((await loadConfig(repoRoot)).agents);
      await parseWorkflowText(name, text, agents, repoRoot, `${name}.yaml`);
    } catch (error) {
      return json({ ok: false, error: errText(error) }, 200);
    }
    const file = workflowPath(scope, repoRoot, name);
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, text);
    return json({ ok: true });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!hostAllowed(req.headers.get("host"), port)) return new Response("forbidden", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && !hostAllowed(origin, port)) return new Response("forbidden", { status: 403 });

    if (url.pathname === "/") {
      if (url.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
      return new Response(PAGE.replace("__HWF_TOKEN__", token), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (req.headers.get("x-hwf-token") !== token) return new Response("forbidden", { status: 403 });

    const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

    if (url.pathname === "/api/state") {
      const agents = Object.keys((await loadConfig(repoRoot)).agents);
      const entries = await listWorkflows(repoRoot, agents);
      const mapped = await Promise.all(
        entries.map(async (e) => ({
          name: e.name,
          source: e.source,
          valid: !e.error,
          inRepo: await Bun.file(workflowPath("repo", repoRoot, e.name)).exists(),
          inGlobal: await Bun.file(workflowPath("global", repoRoot, e.name)).exists(),
        })),
      );
      return json({ repoRoot: shortPath(repoRoot), agents, entries: mapped });
    }

    if (url.pathname === "/api/workflow") {
      if (req.method === "GET") {
        const name = url.searchParams.get("name");
        const scope = scopeOf(url.searchParams.get("scope"));
        if (!name || !scope) return json({ error: "name and scope required" }, 400);
        const text = await Bun.file(workflowPath(scope, repoRoot, name)).text().catch(() => "");
        let valid = true;
        let error: string | undefined;
        if (text) {
          try {
            const agents = Object.keys((await loadConfig(repoRoot)).agents);
            await parseWorkflowText(name, text, agents, repoRoot, `${name}.yaml`);
          } catch (e) {
            valid = false;
            error = errText(e);
          }
        }
        return json({ text, valid, error });
      }
      if (req.method === "PUT") {
        const name = String(body.name ?? "");
        const scope = scopeOf(body.scope);
        if (!scope) return json({ ok: false, error: "scope required" }, 400);
        return writeWorkflow(name, scope, String(body.text ?? ""));
      }
      if (req.method === "DELETE") {
        const name = String(body.name ?? "");
        const scope = scopeOf(body.scope);
        if (!WORKFLOW_NAME_RE.test(name) || !scope)
          return json({ ok: false, error: "name and scope required" }, 400);
        await Bun.file(workflowPath(scope, repoRoot, name)).delete().catch(() => {});
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/parse" && req.method === "POST") {
      try {
        const doc = parseRaw("buffer.yaml", String(body.text ?? ""));
        return json({ ok: true, doc });
      } catch (error) {
        return json({ ok: false, error: errText(error) });
      }
    }

    if (url.pathname === "/api/format" && req.method === "POST") {
      try {
        const doc = parseRaw("buffer.yaml", dumpWorkflow(body.doc as never));
        return json({ ok: true, text: dumpWorkflow(doc) });
      } catch (error) {
        return json({ ok: false, error: errText(error) });
      }
    }

    if (url.pathname === "/api/validate" && req.method === "POST") {
      const name = String(body.name ?? "buffer");
      try {
        const agents = Object.keys((await loadConfig(repoRoot)).agents);
        await parseWorkflowText(name, String(body.text ?? ""), agents, repoRoot, `${name}.yaml`);
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: errText(error) });
      }
    }

    if (url.pathname === "/api/promote" && req.method === "POST") {
      const name = String(body.name ?? "");
      const from = scopeOf(body.from);
      const to = scopeOf(body.to);
      if (!WORKFLOW_NAME_RE.test(name) || !from || !to)
        return json({ ok: false, error: "name, from, to required" }, 400);
      const src = Bun.file(workflowPath(from, repoRoot, name));
      if (!(await src.exists())) return json({ ok: false, error: "source not found" }, 404);
      const dstPath = workflowPath(to, repoRoot, name);
      if (body.force !== true && (await Bun.file(dstPath).exists()))
        return json({ ok: false, error: `'${name}' already exists in ${to}` }, 409);
      await mkdir(dirname(dstPath), { recursive: true });
      await Bun.write(dstPath, await src.text());
      return json({ ok: true });
    }

    if (url.pathname === "/api/config") {
      const scope = scopeOf(req.method === "GET" ? url.searchParams.get("scope") : body.scope);
      if (!scope) return json({ ok: false, error: "scope required" }, 400);
      const file = configPath(scope);
      if (req.method === "GET") {
        const text = await Bun.file(file).text().catch(() => "");
        return json({ text });
      }
      if (req.method === "PUT") {
        const text = String(body.text ?? "");
        try {
          parseConfigText(file, text);
        } catch (error) {
          return json({ ok: false, error: errText(error) });
        }
        await mkdir(dirname(file), { recursive: true });
        await Bun.write(file, text);
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/runs" && req.method === "GET") {
      return json({ runs: recentRuns(await readRunLog()) });
    }

    return new Response("not found", { status: 404 });
  };
}

export type WebServer = { url: string; token: string; stop: () => void };

export async function startWebServer(opts: {
  repoRoot: string;
  port?: number;
  token?: string;
}): Promise<WebServer> {
  const token = opts.token ?? crypto.randomUUID();
  let port = opts.port ?? 7317;
  for (;;) {
    try {
      const handler = createHandler(opts.repoRoot, token, port);
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
      const url = `http://127.0.0.1:${port}/?token=${token}`;
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
