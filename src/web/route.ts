const SCOPED_ROUTE_RE = /^(w|share)=(repo|global):([a-z0-9][a-z0-9-_]*)$/;
const RUN_ROUTE_RE = /^run=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
