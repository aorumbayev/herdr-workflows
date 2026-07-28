const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;
const SCOPED_ROUTE_RE = /^(w|share)=(repo|global):([a-z0-9][a-z0-9-_]*)$/;

export type WebRoute =
  | { kind: "w" | "share"; scope: "repo" | "global"; name: string; hash: string }
  | { kind: "import"; hash: "import" };

export function parseWebRoute(raw: string): WebRoute | undefined {
  if (raw === "import") return { kind: "import", hash: "import" };
  const m = SCOPED_ROUTE_RE.exec(raw);
  if (!m) return undefined;
  const kind = m[1] as "w" | "share";
  const scope = m[2] as "repo" | "global";
  const name = m[3]!;
  if (!WORKFLOW_NAME_RE.test(name)) return undefined;
  return { kind, scope, name, hash: `${kind}=${scope}:${name}` };
}

export function appendRouteHash(url: string, route: WebRoute | undefined): string {
  if (!route) return url;
  return `${url}#${route.hash}`;
}
