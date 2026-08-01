/**
 * Survive a reader that left. A detached `hwf run` outlives the picker holding the read end of its
 * pipes; without a listener the EPIPE surfaces as an uncaught stream error and kills the run
 * part-way through the workflow. The write is async, so a try/catch at the call site never sees it.
 */
export function tolerateClosedStdio(): void {
  process.stdout.on("error", tolerateClosedPipe);
  process.stderr.on("error", tolerateClosedPipe);
}

function tolerateClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}

export function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

type U8Reader = ReadableStreamDefaultReader<Uint8Array>;

let reader: U8Reader | undefined;
let stdinBuf = "";
const decoder = new TextDecoder();

export type PromptResult = { kind: "line"; text: string } | { kind: "cancel" };

function hasBareEsc(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0x1b) continue;
    const next = raw[i + 1];
    if (next !== "[" && next !== "O") return true;
  }
  return false;
}

/** herdr prefix leaks into popup stdin — strip C0 controls (keep tab/CR/LF/ESC). */
function sanitizePromptInput(raw: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional C0 strip for leaked herdr prefix keys
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");
}

/** Strip C0 controls from AI/evidence text before writing to the terminal (keep tab/CR/LF). */
export function sanitizeDisplay(raw: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional C0 strip before terminal write
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function interpretLine(raw: string): PromptResult {
  if (hasBareEsc(raw)) return { kind: "cancel" };
  const text = sanitizePromptInput(raw).replace(/\r$/, "").trim();
  return { kind: "line", text };
}

export async function readLine(): Promise<PromptResult> {
  // Bun's getReader() typings omit readMany; cast keeps a single shared stdin reader.
  if (!reader) reader = Bun.stdin.stream().getReader() as unknown as U8Reader;
  const r = reader;
  while (true) {
    const nl = stdinBuf.indexOf("\n");
    if (nl !== -1) {
      const line = stdinBuf.slice(0, nl);
      stdinBuf = stdinBuf.slice(nl + 1);
      return interpretLine(line);
    }
    const { done, value } = await r.read();
    if (done) {
      const rest = stdinBuf;
      stdinBuf = "";
      if (!rest) return { kind: "cancel" };
      return interpretLine(rest);
    }
    stdinBuf += decoder.decode(value, { stream: true });
  }
}

/** Drop the shared stdin lock so short-lived CLI commands can exit after prompts. */
export async function releaseStdinReader(): Promise<void> {
  const r = reader;
  if (!r) return;
  reader = undefined;
  stdinBuf = "";
  try {
    await r.cancel();
  } catch {
    /* already closed */
  }
}

export async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
  } catch {
    /* opener absence is nonfatal */
  }
}
