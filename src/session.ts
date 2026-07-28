import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptExtractor } from "./config";
import { agentSessionInfo, HerdrError, type AgentSessionInfo } from "./herdr";
import { assertUnderCaptureCap, CaptureLimitError } from "./limits";
import { spawnCapture } from "./run/steps/shell";

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

export function extractSessionTranscript(jsonl: string): string {
  const entries: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = parsed as { type?: unknown; message?: { content?: unknown } };
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (!row.message || row.message.content === undefined) continue;
    const text = extractText(row.message.content);
    if (!text) continue;
    entries.push(`${row.type}:\n${text}`);
  }
  return entries.join("\n\n");
}

export async function readClaudeTranscript(
  cwd: string,
  sessionId: string,
  base = join(homedir(), ".claude", "projects"),
): Promise<string> {
  const path = join(base, slug(cwd), `${sessionId}.jsonl`);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new HerdrError("transcript_file_missing", `transcript file not found: ${path}`);
  }
  try {
    const text = extractSessionTranscript(await file.text());
    assertUnderCaptureCap("transcript", text);
    return text;
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
  const cwd = info.cwd || invocationCwd;
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
