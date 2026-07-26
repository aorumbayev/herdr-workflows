import { loadConfig } from "../config";
import { readRunLog, recentRuns } from "../runlog";
import { workflowPath } from "../workflows/discover";
import { listWorkflows, parseWorkflowText } from "../workflows/load";
import { normalizeSteps, parseRaw, rawWorkflowSchema } from "../workflows/parse";
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

export async function agentsOf(repoRoot: string): Promise<string[]> {
  return Object.keys((await loadConfig(repoRoot)).agents);
}

export async function getState(
  repoRoot: string,
  shortPath: (p: string) => string,
): Promise<Response> {
  const agents = await agentsOf(repoRoot);
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
    const text = dumpWorkflow({
      ...parsed.data,
      steps: normalizeSteps(parsed.data.steps),
    });
    parseRaw("buffer.yaml", text);
    return json({ ok: true, text });
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
    const agents = await agentsOf(repoRoot);
    await parseWorkflowText(name, String(body.text ?? ""), agents, repoRoot, `${name}.yaml`);
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: errText(error) }, 400);
  }
}

export async function handleRuns(): Promise<Response> {
  return json({ runs: recentRuns(await readRunLog()) });
}
