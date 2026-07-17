import type { PlaceholderValues } from "./errors";

const RE = /\{(pane|selection|prompt|last|error|session|tab|prev_tab|agent)\}/g;

export function substitute(template: string, values: PlaceholderValues): string {
  return template.replace(RE, (_, name: keyof PlaceholderValues) => values[name] ?? "");
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
  return RE.exec(command)?.[1];
}

export function textHasPrompt(text: string): boolean {
  return text.includes("{prompt}");
}

export function textHasSession(text: string): boolean {
  return text.includes("{session}");
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
