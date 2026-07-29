export const CAPTURE_BYTE_LIMIT = 8 * 1024 * 1024;
export const HWF_ENV_BYTE_LIMIT = 24 * 1024;

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

export function assertUnderHwfEnvCap(source: string, text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes > HWF_ENV_BYTE_LIMIT) throw new CaptureLimitError(source, bytes, HWF_ENV_BYTE_LIMIT);
}

/** Serialize collected inputs as the generated `HWF_*` environment block. */
function formatHwfEnvBlock(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `HWF_${name}=${value}`)
    .join("\n");
}

export function assertHwfEnvValues(source: string, values: Record<string, string>): void {
  assertUnderHwfEnvCap(source, formatHwfEnvBlock(values));
}
