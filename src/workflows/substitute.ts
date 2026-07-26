import { BUILTIN_NAMES, type PlaceholderValues } from "./types";

export const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const IDENT_PLACEHOLDER_RE = /\{([a-z][a-z0-9_]{0,31})\}/g;
const V1_INPUT_PLACEHOLDER_RE = /\{input\.([a-z][a-z0-9_]{0,31})\}/g;

const BUILTIN_SET = new Set<string>(BUILTIN_NAMES);

export function isBuiltin(name: string): boolean {
  return BUILTIN_SET.has(name);
}

export function substitute(template: string, values: PlaceholderValues): string {
  return template.replace(IDENT_PLACEHOLDER_RE, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : match,
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

/** Identifier-shaped placeholders in text (excludes non-identifier braces like `{"a":1}`). */
export function textPlaceholders(text: string): string[] {
  IDENT_PLACEHOLDER_RE.lastIndex = 0;
  const names: string[] = [];
  for (let m = IDENT_PLACEHOLDER_RE.exec(text); m; m = IDENT_PLACEHOLDER_RE.exec(text)) {
    names.push(m[1]!);
  }
  return names;
}

export function firstPlaceholder(text: string): string | undefined {
  IDENT_PLACEHOLDER_RE.lastIndex = 0;
  const m = IDENT_PLACEHOLDER_RE.exec(text);
  return m?.[1];
}

export function textHasPrompt(text: string): boolean {
  return textPlaceholders(text).includes("prompt");
}

export function textHasSession(text: string): boolean {
  const names = textPlaceholders(text);
  return names.includes("session") || names.includes("session_file");
}

export function paramsPlaceholders(params: Record<string, unknown> | undefined): string[] {
  if (!params) return [];
  const refs: string[] = [];
  walkParams(params, (text) => {
    refs.push(...textPlaceholders(text));
    return text;
  });
  return refs;
}

function paramsAnyText(
  params: Record<string, unknown> | undefined,
  pred: (text: string) => boolean,
): boolean {
  if (!params) return false;
  let found = false;
  walkParams(params, (text) => {
    found ||= pred(text);
    return text;
  });
  return found;
}

export function paramsHavePrompt(params: Record<string, unknown> | undefined): boolean {
  return paramsAnyText(params, textHasPrompt);
}

export function paramsHaveSession(params: Record<string, unknown> | undefined): boolean {
  return paramsAnyText(params, textHasSession);
}

export function findV1InputPlaceholder(text: string): string | undefined {
  V1_INPUT_PLACEHOLDER_RE.lastIndex = 0;
  const m = V1_INPUT_PLACEHOLDER_RE.exec(text);
  return m?.[1];
}

export function findV1Last(text: string): boolean {
  return textPlaceholders(text).includes("last");
}
