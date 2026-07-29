import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateDir } from "./config";

export type RunLogEntry = {
  ts: string;
  run: string;
  workflow: string;
  step?: number;
  total?: number;
  label?: string;
  ok: boolean;
  skipped?: boolean;
  launched?: boolean;
  blocked?: boolean;
  interrupted?: boolean;
  error?: string;
  returns?: unknown;
};

const RUN_LOG_MAX_BYTES = 512_000;
const RUN_LOG_KEEP_LINES = 2_000;
const RUN_LOG_READ_TAIL_BYTES = 128_000;

export function runLogPath(): string {
  return join(pluginStateDir(), "runs.jsonl");
}

function parseLines(text: string): RunLogEntry[] {
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
}

async function trimRunLogIfNeeded(): Promise<void> {
  const path = runLogPath();
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size <= RUN_LOG_MAX_BYTES) return;
  const entries = parseLines(await file.text());
  const kept = entries.slice(-RUN_LOG_KEEP_LINES);
  await Bun.write(path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
}

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  try {
    await mkdir(pluginStateDir(), { recursive: true });
    await appendFile(runLogPath(), `${JSON.stringify(entry)}\n`);
    await trimRunLogIfNeeded();
  } catch {
    // observability must not break a workflow run
  }
}

async function readFileTail(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return "";
  const start = Math.max(0, size - maxBytes);
  let text = await file.slice(start).text();
  if (start > 0) {
    const nl = text.indexOf("\n");
    text = nl === -1 ? text : text.slice(nl + 1);
  }
  return text;
}

export async function readRunLog(): Promise<RunLogEntry[]> {
  try {
    return parseLines(await readFileTail(runLogPath(), RUN_LOG_READ_TAIL_BYTES));
  } catch {
    return [];
  }
}

const RECENT_RUNS_LIMIT = 40;

/** Final per-run entries (no step), newest first. */
export function recentRuns(entries: RunLogEntry[]): RunLogEntry[] {
  const finals = entries.filter((e) => e.step === undefined);
  return finals.slice(-RECENT_RUNS_LIMIT).reverse();
}
