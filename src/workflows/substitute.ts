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

function walkParams(value: unknown, mapText: (text: string) => string): unknown {
  if (typeof value === "string") return mapText(value);
  if (Array.isArray(value)) return value.map((item) => walkParams(item, mapText));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walkParams(item, mapText)]),
    );
  }
  return value;
}

export function substituteParams(
  params: Record<string, unknown> | undefined,
  values: PlaceholderValues,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  return walkParams(params, (text) => substitute(text, values)) as Record<string, unknown>;
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
  walkParams(params, (text) => {
    refs.push(...textInputRefs(text));
    return text;
  });
  return refs;
}

export function paramsHavePrompt(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  let found = false;
  walkParams(params, (text) => {
    found ||= textHasPrompt(text);
    return text;
  });
  return found;
}

export function paramsHaveSession(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  let found = false;
  walkParams(params, (text) => {
    found ||= textHasSession(text);
    return text;
  });
  return found;
}
