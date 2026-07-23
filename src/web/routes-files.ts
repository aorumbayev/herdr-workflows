import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { globalConfigPath, loadConfig, parseConfigText, repoConfigPath } from "../config";
import { parseWorkflowText, workflowPath } from "../workflows";
import { errText, json, scopeOf, type Scope } from "./routes";

const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

async function agentsOf(repoRoot: string): Promise<string[]> {
  return Object.keys((await loadConfig(repoRoot)).agents);
}

async function writeWorkflow(
  repoRoot: string,
  name: string,
  scope: Scope,
  text: string,
): Promise<Response> {
  if (!WORKFLOW_NAME_RE.test(name)) return json({ ok: false, error: "invalid workflow name" }, 400);
  try {
    await parseWorkflowText(name, text, await agentsOf(repoRoot), repoRoot, `${name}.yaml`);
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
  const file = workflowPath(scope, repoRoot, name);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, text);
  return json({ ok: true });
}

export async function handleWorkflow(
  repoRoot: string,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response> {
  if (req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const scope = scopeOf(url.searchParams.get("scope"));
    if (!WORKFLOW_NAME_RE.test(name) || !scope)
      return json({ error: "valid name and scope required" }, 400);
    const text = await Bun.file(workflowPath(scope, repoRoot, name))
      .text()
      .catch(() => "");
    let valid = true;
    let error: string | undefined;
    if (text) {
      try {
        await parseWorkflowText(name, text, await agentsOf(repoRoot), repoRoot, `${name}.yaml`);
      } catch (e) {
        valid = false;
        error = errText(e);
      }
    }
    return json({ text, valid, error });
  }
  if (req.method === "PUT") {
    const scope = scopeOf(body.scope);
    if (!scope) return json({ ok: false, error: "scope required" }, 400);
    return writeWorkflow(repoRoot, String(body.name ?? ""), scope, String(body.text ?? ""));
  }
  if (req.method === "DELETE") {
    const name = String(body.name ?? "");
    const scope = scopeOf(body.scope);
    if (!WORKFLOW_NAME_RE.test(name) || !scope)
      return json({ ok: false, error: "name and scope required" }, 400);
    await Bun.file(workflowPath(scope, repoRoot, name))
      .delete()
      .catch(() => {});
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405 });
}

export async function handlePromote(
  repoRoot: string,
  body: Record<string, unknown>,
): Promise<Response> {
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

export async function handleConfig(
  repoRoot: string,
  req: Request,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response> {
  const scope = scopeOf(req.method === "GET" ? url.searchParams.get("scope") : body.scope);
  if (!scope) return json({ ok: false, error: "scope required" }, 400);
  const file = scope === "repo" ? repoConfigPath(repoRoot) : globalConfigPath();
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
