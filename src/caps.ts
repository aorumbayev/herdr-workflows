export const CAPTURE_BYTE_LIMIT = 8 * 1024 * 1024;
/**
 * Raw claude session .jsonl is dominated by tool output the built-in extractor
 * discards, so the transcript cap applies to the extracted text. This only
 * bounds how large a raw session file the extractor will load.
 */
export const TRANSCRIPT_FILE_BYTE_LIMIT = 32 * CAPTURE_BYTE_LIMIT;
/**
 * A record is buffered whole before its type is known, so this bounds the memory
 * one JSONL record can hold. One record's extracted text can approach the 8 MiB
 * transcript cap and JSON escaping plus non-text blocks multiply the raw size,
 * so 4x leaves headroom for legitimate records.
 */
export const TRANSCRIPT_RECORD_BYTE_LIMIT = 4 * CAPTURE_BYTE_LIMIT;
export const HWF_ENV_BYTE_LIMIT = 24 * 1024;
/**
 * herdr agent.prompt silently drops ~21KB+ bodies; stay under this with a margin.
 * Oversized prompts are written to a run-owned file and replaced by a short pointer.
 */
export const AGENT_PROMPT_BYTE_LIMIT = 16 * 1024;

export class CaptureLimitError extends Error {
  readonly source: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(source: string, bytes: number, limit: number = CAPTURE_BYTE_LIMIT) {
    super(`${source} exceeded ${limit} byte limit (${bytes} bytes)`);
    this.name = "CaptureLimitError";
    this.source = source;
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function assertUnderCaptureCap(source: string, text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes > CAPTURE_BYTE_LIMIT) throw new CaptureLimitError(source, bytes);
}

function assertUnderHwfEnvCap(source: string, text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes > HWF_ENV_BYTE_LIMIT) throw new CaptureLimitError(source, bytes, HWF_ENV_BYTE_LIMIT);
}

/**
 * Model the byte size of the generated `HWF_*` environment block for the cap check only.
 * `buildHwfEnv` in `src/engine/command.ts` builds the real environment.
 */
function formatHwfEnvBlock(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `HWF_${name}=${value}`)
    .join("\n");
}

export function assertHwfEnvValues(source: string, values: Record<string, string>): void {
  assertUnderHwfEnvCap(source, formatHwfEnvBlock(values));
}
