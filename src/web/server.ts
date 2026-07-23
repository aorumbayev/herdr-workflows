import { homedir } from "node:os";
import {
  errText,
  getState,
  handleFormat,
  handleParse,
  handleRuns,
  handleValidate,
  json,
} from "./routes";
import { handleConfig, handlePromote, handleWorkflow } from "./routes-files";
import pageHtml from "./page.html" with { type: "text" };

const PAGE = pageHtml as unknown as string;

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

      if (url.pathname === "/api/state") return getState(repoRoot, shortPath);
      if (url.pathname === "/api/workflow") return handleWorkflow(repoRoot, req, url, body);
      if (url.pathname === "/api/parse" && req.method === "POST") return handleParse(body);
      if (url.pathname === "/api/format" && req.method === "POST") return handleFormat(body);
      if (url.pathname === "/api/validate" && req.method === "POST")
        return handleValidate(repoRoot, body);
      if (url.pathname === "/api/promote" && req.method === "POST")
        return handlePromote(repoRoot, body);
      if (url.pathname === "/api/config") return handleConfig(repoRoot, req, url, body);
      if (url.pathname === "/api/runs" && req.method === "GET") return handleRuns();
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
  token?: string;
}): Promise<WebServer> {
  const token = opts.token ?? crypto.randomUUID();
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
