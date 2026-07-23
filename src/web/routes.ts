import { loadConfig } from "../config";
import { readRunLog, recentRuns } from "../runlog";
import { listWorkflows, parseRaw, parseWorkflowText, workflowPath } from "../workflows";
import { dumpWorkflow } from "./yaml-build";

export type Scope = "repo" | "global";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scopeOf(v: unknown): Scope | undefined {
  return v === "repo" || v === "global" ? v : undefined;
}

export async function getState(
  repoRoot: string,
  shortPath: (p: string) => string,
): Promise<Response> {
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

export function handleParse(body: Record<string, unknown>): Response {
  try {
    const doc = parseRaw("buffer.yaml", String(body.text ?? ""));
    return json({ ok: true, doc });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

export function handleFormat(body: Record<string, unknown>): Response {
  try {
    const doc = parseRaw("buffer.yaml", dumpWorkflow(body.doc as never));
    return json({ ok: true, text: dumpWorkflow(doc) });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

export async function handleValidate(
  repoRoot: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const name = String(body.name ?? "buffer");
  try {
    const agents = Object.keys((await loadConfig(repoRoot)).agents);
    await parseWorkflowText(name, String(body.text ?? ""), agents, repoRoot, `${name}.yaml`);
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

export async function handleRuns(): Promise<Response> {
  return json({ runs: recentRuns(await readRunLog()) });
}
