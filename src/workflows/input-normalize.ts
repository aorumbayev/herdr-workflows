import { bail } from "./types";
import type { RawWorkflow } from "./parse";

const AGENTS_BUILTIN = "agents";
const TEXT_DEFAULT_RE = /^text\s*=\s*(.*)$/s;
const SH_OPTIONS_RE = /^sh\s+(.+)$/s;

function unquoteDefault(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export type NormalizedInput = {
  label?: string;
  desc?: string;
  options?: string | string[];
  default?: string;
  text?: boolean;
};

export function normalizeInput(
  file: string,
  name: string,
  raw: NonNullable<RawWorkflow["inputs"]>[string],
): NormalizedInput {
  if (typeof raw === "string") {
    if (raw === "text") return { text: true };
    if (raw === AGENTS_BUILTIN) return { options: AGENTS_BUILTIN };
    const textDef = TEXT_DEFAULT_RE.exec(raw);
    if (textDef) return { text: true, default: unquoteDefault(textDef[1]!) };
    const sh = SH_OPTIONS_RE.exec(raw);
    if (sh) return { options: sh[1]! };
    bail(
      file,
      undefined,
      `inputs.${name}`,
      `unknown input shorthand '${raw}' (expected text, text = …, agents, sh <cmd>, or a list)`,
    );
  }
  if (Array.isArray(raw)) return { options: raw };
  const map = raw;
  if (map.type === "agents") {
    return { options: AGENTS_BUILTIN, label: map.label, desc: map.desc, default: map.default };
  }
  if (map.options !== undefined) {
    return {
      label: map.label,
      desc: map.desc,
      options: map.options,
      default: map.default,
    };
  }
  return {
    text: true,
    label: map.label,
    desc: map.desc,
    default: map.default,
  };
}

export { AGENTS_BUILTIN };
