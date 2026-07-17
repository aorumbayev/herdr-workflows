import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunLogEntry = {
  ts: string;
  run: string;
  workflow: string;
  step?: number;
  total?: number;
  label?: string;
  ok: boolean;
  error?: string;
};

function stateDir(): string {
  return process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".hwf", "state");
}

export function runLogPath(): string {
  return join(stateDir(), "runs.jsonl");
}

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  try {
    await mkdir(stateDir(), { recursive: true });
    await appendFile(runLogPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    // observability must not break a workflow run
  }
}

export async function readRunLog(): Promise<RunLogEntry[]> {
  try {
    const text = await Bun.file(runLogPath()).text();
    const out: RunLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as RunLogEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Final per-run entries (no step), newest first. */
export function recentRuns(entries: RunLogEntry[], limit = 40): RunLogEntry[] {
  const finals = entries.filter((e) => e.step === undefined);
  return finals.slice(-limit).reverse();
}
