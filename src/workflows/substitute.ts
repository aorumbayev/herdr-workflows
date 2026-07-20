import type { PlaceholderValues } from "./errors";

export const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

const RE =
  /\{(pane|selection|prompt|last|error|session|tab|prev_tab|agent)\}|\{input\.([a-z][a-z0-9_]{0,31})\}/g;

export function substitute(template: string, values: PlaceholderValues): string {
  return template.replace(RE, (_, name: string | undefined, input?: string) =>
    input !== undefined
      ? (values.inputs[input] ?? "")
      : String(values[name as keyof Omit<PlaceholderValues, "inputs">] ?? ""),
  );
}

export function substituteParams(
  params: Record<string, unknown> | undefined,
  values: PlaceholderValues,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") out[key] = substitute(value, values);
    else if (value && typeof value === "object" && !Array.isArray(value))
      out[key] = substituteParams(value as Record<string, unknown>, values);
    else out[key] = value;
  }
  return out;
}

export function commandHasPlaceholder(command: string): string | undefined {
  RE.lastIndex = 0;
  const m = RE.exec(command);
  if (!m) return undefined;
  return m[2] !== undefined ? `input.${m[2]}` : m[1];
}

export function textHasPrompt(text: string): boolean {
  return text.includes("{prompt}");
}

export function textHasSession(text: string): boolean {
  return text.includes("{session}");
}

export function textInputRefs(text: string): string[] {
  RE.lastIndex = 0;
  const refs: string[] = [];
  for (let m = RE.exec(text); m; m = RE.exec(text)) {
    if (m[2] !== undefined) refs.push(m[2]);
  }
  return refs;
}

export function paramsInputRefs(params: Record<string, unknown> | undefined): string[] {
  if (!params) return [];
  const refs: string[] = [];
  for (const value of Object.values(params)) {
    if (typeof value === "string") refs.push(...textInputRefs(value));
    else if (value && typeof value === "object" && !Array.isArray(value))
      refs.push(...paramsInputRefs(value as Record<string, unknown>));
  }
  return refs;
}

export function paramsHavePrompt(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  for (const value of Object.values(params)) {
    if (typeof value === "string" && textHasPrompt(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (paramsHavePrompt(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}

export function paramsHaveSession(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  for (const value of Object.values(params)) {
    if (typeof value === "string" && textHasSession(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (paramsHaveSession(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}
