import { platformName, sanitizeDisplay, type InvocationContext } from "../context";
import {
  TEMPLATE_INNER,
  WHOLE_TEMPLATE_RE,
  type RecoveryAction,
  type ReturnsSpec,
  type TemplateNamespace,
  type TemplatePath,
  type TemplateRoot,
  type WorkflowStep,
} from "./types";

const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TEMPLATE_PATH_RE = new RegExp(`^${TEMPLATE_INNER}$`);
const TEMPLATE_FIND_RE = new RegExp(`\\{\\{\\s*(${TEMPLATE_INNER})\\s*\\}\\}`, "g");

export function parseTemplatePath(path: string): TemplatePath | undefined {
  const trimmed = path.trim();
  if (!TEMPLATE_PATH_RE.test(trimmed)) return undefined;
  const parts = trimmed.split(".");
  const root = parts[0] as TemplateRoot;
  const segments = parts.slice(1);
  if (segments.length === 0 || !segments.every((s) => PATH_SEGMENT_RE.test(s))) return undefined;
  return { root, segments };
}

export function isWholeValueTemplate(text: string): boolean {
  return WHOLE_TEMPLATE_RE.test(text);
}

export function textTemplates(text: string): TemplatePath[] {
  TEMPLATE_FIND_RE.lastIndex = 0;
  const out: TemplatePath[] = [];
  for (let m = TEMPLATE_FIND_RE.exec(text); m; m = TEMPLATE_FIND_RE.exec(text)) {
    const parsed = parseTemplatePath(m[1]!);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function malformedTemplateSnippet(text: string): string | undefined {
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf("{{", from);
    if (start === -1) return undefined;
    const close = text.indexOf("}}", start + 2);
    if (close === -1) return text.slice(start);
    const snippet = text.slice(start, close + 2);
    if (!parseTemplatePath(text.slice(start + 2, close))) return snippet;
    from = close + 2;
  }
  return undefined;
}

/** Recurse string/array/object leaves; visit may map or assert. */
export function walkValueStrings(
  value: unknown,
  key: string,
  visit: (text: string, key: string) => unknown,
): unknown {
  if (typeof value === "string") return visit(value, key);
  if (Array.isArray(value)) {
    return value.map((item, i) => walkValueStrings(item, `${key}[${i}]`, visit));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [k, walkValueStrings(item, `${key}.${k}`, visit)]),
    );
  }
  return value;
}

function resolvePath(ns: TemplateNamespace, path: TemplatePath): unknown {
  let cur: unknown = ns[path.root];
  for (const seg of path.segments) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(value);
  }
  return JSON.stringify(value);
}

export function substituteText(template: string, ns: TemplateNamespace): string {
  return template.replace(TEMPLATE_FIND_RE, (_match, path: string) => {
    const parsed = parseTemplatePath(path);
    if (!parsed) return _match;
    return renderScalar(resolvePath(ns, parsed));
  });
}

export function substituteValue(template: string, ns: TemplateNamespace): unknown {
  const whole = WHOLE_TEMPLATE_RE.exec(template);
  if (whole) {
    const parsed = parseTemplatePath(whole[1]!);
    if (!parsed) return template;
    return resolvePath(ns, parsed);
  }
  return substituteText(template, ns);
}

export function substituteParams(
  params: Record<string, unknown> | undefined,
  ns: TemplateNamespace,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  return walkValueStrings(params, "", (text) => substituteValue(text, ns)) as Record<
    string,
    unknown
  >;
}

function collectTemplatesFromValue(value: unknown, out: TemplatePath[]): void {
  walkValueStrings(value, "", (text) => {
    out.push(...textTemplates(text));
    return text;
  });
}

function stepTemplates(step: WorkflowStep): TemplatePath[] {
  const out: TemplatePath[] = [];
  for (const clause of step.when ?? []) {
    const p = parseTemplatePath(clause.path);
    if (p) out.push(p);
  }
  const a = step.action;
  if (a.kind === "agent") {
    out.push(...textTemplates(a.prompt));
    if (a.using) out.push(...textTemplates(a.using));
    if (a.target) out.push(...textTemplates(a.target));
    if (a.cwd) out.push(...textTemplates(a.cwd));
    if (a.env) collectTemplatesFromValue(a.env, out);
    if (a.pane) collectTemplatesFromValue(a.pane, out);
  } else if (a.kind === "run") {
    if (a.payload.form === "argv") for (const el of a.payload.argv) out.push(...textTemplates(el));
    if (a.cwd) out.push(...textTemplates(a.cwd));
    if (a.env) collectTemplatesFromValue(a.env, out);
    if (a.pane) collectTemplatesFromValue(a.pane, out);
  } else if (a.kind === "herdr") {
    collectTemplatesFromValue(a.params, out);
  } else {
    if (a.inputs) collectTemplatesFromValue(a.inputs, out);
  }
  return out;
}

const SENSITIVE_CONTEXT_KEYS = new Set(["transcript", "transcript_file"]);

export function isSensitiveContextPath(path: TemplatePath): boolean {
  return path.root === "context" && SENSITIVE_CONTEXT_KEYS.has(path.segments[0] ?? "");
}

export function workflowTemplateRefs(
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
): TemplatePath[] {
  const refs = steps.flatMap(stepTemplates);
  if (returns?.kind === "template") refs.push(...textTemplates(returns.template));
  if (returns?.kind === "map") {
    for (const t of Object.values(returns.fields)) refs.push(...textTemplates(t));
  }
  if (onFailure) refs.push(...stepTemplates({ action: onFailure }));
  return refs;
}

export function workflowNeedsTranscript(steps: WorkflowStep[], returns?: ReturnsSpec): boolean {
  return workflowTemplateRefs(steps, returns).some(isSensitiveContextPath);
}

export function buildTemplateNamespace(opts: {
  ctx: InvocationContext;
  inputs?: Record<string, string>;
  steps?: Record<string, unknown>;
  agent?: string;
  transcript?: string;
  transcriptFile?: string;
}): TemplateNamespace {
  return {
    inputs: { ...opts.inputs },
    steps: { ...opts.steps },
    context: {
      workspace: opts.ctx.workspaceId ?? "",
      tab: opts.ctx.tabId ?? "",
      pane: opts.ctx.paneId ?? "",
      worktree: opts.ctx.worktreePath ?? "",
      agent: opts.agent ?? "",
      selection: sanitizeDisplay(opts.ctx.selection),
      platform: platformName(),
      ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
      ...(opts.transcriptFile !== undefined ? { transcript_file: opts.transcriptFile } : {}),
    },
  };
}
