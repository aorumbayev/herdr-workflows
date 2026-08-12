import { homedir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_BYTE_LIMIT,
  CaptureLimitError,
  TRANSCRIPT_FILE_BYTE_LIMIT,
  TRANSCRIPT_RECORD_BYTE_LIMIT,
  assertUnderCaptureCap,
} from "./caps";
import type { TranscriptExtractor } from "./context";
import type { AgentSessionInfo } from "./host";

const TRANSCRIPT_TIMEOUT_MS = 30_000;

export function slug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

type ContentBlock = { type?: unknown; text?: unknown };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function extractEntry(line: string): string | undefined {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const row = parsed as { type?: unknown; message?: { content?: unknown } };
  if (row.type !== "user" && row.type !== "assistant") return;
  if (!row.message || row.message.content === undefined) return;
  const text = extractText(row.message.content);
  return text ? `${row.type}:\n${text}` : undefined;
}

export function extractAgentTranscript(jsonl: string): string {
  const entries: string[] = [];
  for (const line of jsonl.split("\n")) {
    const entry = extractEntry(line);
    if (entry) entries.push(entry);
  }
  return entries.join("\n\n");
}

function appendTranscriptEntry(entries: string[], entry: string, bytes: number): number {
  const nextBytes = bytes + (entries.length ? 2 : 0) + Buffer.byteLength(entry);
  if (nextBytes > CAPTURE_BYTE_LIMIT) {
    throw new CaptureLimitError("transcript", nextBytes);
  }
  entries.push(entry);
  return nextBytes;
}

async function readClaudeTranscriptStream(file: Bun.BunFile): Promise<string> {
  const decoder = new TextDecoder();
  let line = "";
  const entries: string[] = [];
  let transcriptBytes = 0;
  let bytesRead = 0;

  const consumeLine = (completedLine: string): void => {
    const recordBytes = Buffer.byteLength(completedLine);
    if (recordBytes > TRANSCRIPT_RECORD_BYTE_LIMIT) {
      throw new CaptureLimitError("transcript record", recordBytes, TRANSCRIPT_RECORD_BYTE_LIMIT);
    }
    const entry = extractEntry(completedLine);
    if (entry) transcriptBytes = appendTranscriptEntry(entries, entry, transcriptBytes);
  };

  for await (const chunk of file.stream()) {
    bytesRead += chunk.byteLength;
    if (bytesRead > TRANSCRIPT_FILE_BYTE_LIMIT) {
      throw new CaptureLimitError("transcript file", bytesRead, TRANSCRIPT_FILE_BYTE_LIMIT);
    }
    line += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = line.indexOf("\n")) !== -1) {
      consumeLine(line.slice(0, newline));
      line = line.slice(newline + 1);
    }
    // UTF-16 length lower-bounds UTF-8 bytes: the partial record is rejected
    // before it grows unbounded without an O(n^2) byte count per chunk.
    if (line.length > TRANSCRIPT_RECORD_BYTE_LIMIT) {
      throw new CaptureLimitError(
        "transcript record",
        Buffer.byteLength(line),
        TRANSCRIPT_RECORD_BYTE_LIMIT,
      );
    }
  }
  line += decoder.decode();
  consumeLine(line);
  return entries.join("\n\n");
}

export async function readClaudeTranscript(
  cwd: string,
  sessionId: string,
  base = join(homedir(), ".claude", "projects"),
): Promise<string> {
  const { HerdrError } = await import("./host");
  const path = join(base, slug(cwd), `${sessionId}.jsonl`);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError("transcript_file_missing", `transcript file not found: ${path}`);
  }
  try {
    const size = file.size;
    if (size > TRANSCRIPT_FILE_BYTE_LIMIT) {
      throw new CaptureLimitError("transcript file", size, TRANSCRIPT_FILE_BYTE_LIMIT);
    }
    return await readClaudeTranscriptStream(file);
  } catch (error) {
    if (error instanceof HerdrError || error instanceof CaptureLimitError) throw error;
    throw new HerdrError(
      "transcript_file_unreadable",
      `transcript file unreadable: ${path}${error instanceof Error ? ` (${error.message})` : ""}`,
    );
  }
}

function transcriptEnv(
  paneId: string,
  info: AgentSessionInfo,
  invocationCwd: string,
): NodeJS.ProcessEnv {
  const cwd = info.cwd || invocationCwd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HWF_TRANSCRIPT_PANE_ID: paneId,
    HWF_TRANSCRIPT_AGENT_KIND: info.agent,
    HWF_TRANSCRIPT_CWD: cwd,
  };
  if (info.sessionKind) env.HWF_TRANSCRIPT_SESSION_KIND = info.sessionKind;
  if (info.sessionId) env.HWF_TRANSCRIPT_SESSION_VALUE = info.sessionId;
  return env;
}

async function runTranscriptCommand(
  argv: string[],
  paneId: string,
  info: AgentSessionInfo,
  invocationCwd: string,
): Promise<string> {
  const { HerdrError } = await import("./host");
  const cwd = info.cwd || invocationCwd;
  const { spawnCapture } = await import("./engine");
  const result = await spawnCapture(argv, {
    cwd,
    env: transcriptEnv(paneId, info, invocationCwd),
    timeoutMs: TRANSCRIPT_TIMEOUT_MS,
    maxCaptureBytes: { source: "transcript" },
  });

  if (result.timedOut) {
    throw new HerdrError(
      "transcript_command_failed",
      `transcript command for '${info.agent}' failed: timed out after ${result.timeoutMs / 1000}s`,
    );
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-500) || `exit ${result.exitCode}`;
    throw new HerdrError(
      "transcript_command_failed",
      `transcript command for '${info.agent}' failed: ${tail}`,
    );
  }
  if (!result.stdout.trim()) {
    throw new HerdrError(
      "transcript_command_empty",
      `transcript command for '${info.agent}' printed nothing`,
    );
  }
  assertUnderCaptureCap("transcript", result.stdout);
  return result.stdout;
}

export function hasTranscriptSupport(
  agentKind: string,
  transcripts: Record<string, TranscriptExtractor>,
): boolean {
  return agentKind in transcripts || agentKind === "claude";
}

export async function transcriptText(
  paneId: string,
  transcripts: Record<string, TranscriptExtractor> = {},
  opts: {
    invocationCwd: string;
    projectsBase?: string;
    getInfo?: (paneId: string) => Promise<AgentSessionInfo>;
  },
): Promise<string> {
  const { HerdrError, agentSessionInfo } = await import("./host");
  const getInfo = opts.getInfo ?? agentSessionInfo;
  const info = await getInfo(paneId);
  const extractor = transcripts[info.agent];
  if (extractor) {
    return runTranscriptCommand(extractor.command, paneId, info, opts.invocationCwd);
  }
  if (!hasTranscriptSupport(info.agent, transcripts)) {
    throw new HerdrError(
      "transcript_unsupported_kind",
      `no transcript extractor for '${info.agent}' and no built-in support for that kind`,
    );
  }
  const cwd = info.cwd || opts.invocationCwd;
  if (!info.sessionId) {
    throw new HerdrError(
      "transcript_unsupported_kind",
      `no transcript extractor for '${info.agent}' and built-in support requires a native session value`,
    );
  }
  return readClaudeTranscript(cwd, info.sessionId, opts.projectsBase);
}
