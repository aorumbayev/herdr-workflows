type U8Reader = ReadableStreamDefaultReader<Uint8Array>;

let reader: U8Reader | undefined;
let buf = "";
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
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b || c >= 0x20) out += raw[i]!;
  }
  return out;
}

/** Strip C0 controls from AI/evidence text before writing to the terminal (keep tab/CR/LF). */
export function sanitizeDisplay(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d || c >= 0x20) out += raw[i]!;
  }
  return out;
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
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      return interpretLine(line);
    }
    const { done, value } = await r.read();
    if (done) {
      const rest = buf;
      buf = "";
      if (!rest) return { kind: "cancel" };
      return interpretLine(rest);
    }
    buf += decoder.decode(value, { stream: true });
  }
}
