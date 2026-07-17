import { homedir } from "node:os";
import { join } from "node:path";
import { agentSessionInfo, type AgentSessionInfo, HerdrError } from "./adapter/client";
import type { SessionsConfig } from "./config";
import { spawnCapture } from "./runner/shell";

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
    throw new HerdrError("session_file_missing", `session file not found: ${path}`);
  }
  try {
    return extractSessionTranscript(await file.text());
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    throw new HerdrError(
      "session_file_unreadable",
      `session file unreadable: ${path}${error instanceof Error ? ` (${error.message})` : ""}`,
    );
  }
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 500 ? trimmed.slice(-500) : trimmed;
}

async function runSessionCommand(argv: string[], info: AgentSessionInfo): Promise<string> {
  const { timedOut, exitCode, stdout, stderr, timeoutMs } = await spawnCapture(argv, {
    cwd: info.cwd,
    env: {
      ...process.env,
      HERDR_WORKFLOWS_SESSION_ID: info.sessionId,
      HERDR_WORKFLOWS_SESSION_CWD: info.cwd,
      HERDR_WORKFLOWS_SESSION_AGENT: info.agent,
    },
  });

  if (timedOut) {
    throw new HerdrError(
      "session_command_failed",
      `session command for '${info.agent}' failed: timed out after ${timeoutMs / 1000}s`,
    );
  }
  if (exitCode !== 0) {
    const tail = stderrTail(stderr) || `exit ${exitCode}`;
    throw new HerdrError(
      "session_command_failed",
      `session command for '${info.agent}' failed: ${tail}`,
    );
  }
  const text = stdout.trim();
  if (!text) {
    throw new HerdrError(
      "session_command_empty",
      `session command for '${info.agent}' printed nothing`,
    );
  }
  return stdout;
}

export async function sessionText(
  paneId: string,
  sessions: SessionsConfig = {},
  opts: {
    projectsBase?: string;
    getInfo?: (paneId: string) => Promise<AgentSessionInfo>;
  } = {},
): Promise<string> {
  const getInfo = opts.getInfo ?? agentSessionInfo;
  const info = await getInfo(paneId);
  const argv = sessions[info.agent];
  if (argv) return runSessionCommand(argv, info);
  if (info.agent === "claude") {
    return readClaudeTranscript(info.cwd, info.sessionId, opts.projectsBase);
  }
  throw new HerdrError(
    "session_unsupported_agent",
    `no sessions entry for '${info.agent}' — add one to .hwf/config.yaml (built-in support: claude)`,
  );
}
