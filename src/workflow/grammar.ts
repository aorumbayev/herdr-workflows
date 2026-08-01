import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HERDR_METHOD_BY_NAME } from "../herdr-methods.generated";
import { platformName, sanitizeDisplay, type InvocationContext } from "../context";
import { validateHerdrInvocation } from "../host";

export class WorkflowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLoadError";
  }
}

function positioned(
  file: string,
  step: number | undefined,
  key: string | undefined,
  message: string,
): string {
  const parts = [file];
  if (step !== undefined) parts.push(`step ${step}`);
  if (key) parts.push(key);
  return `${parts.join(", ")}: ${message}`;
}

export function bail(
  file: string,
  step: number | undefined,
  key: string | undefined,
  message: string,
): never {
  throw new WorkflowLoadError(positioned(file, step, key, message));
}

export const WORKFLOW_FORMAT = "v1alpha1" as const;
type WorkflowFormat = typeof WORKFLOW_FORMAT;

export const IDENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;
const DURATION_RE = /^([1-9]\d*)(ms|s|m|h)$/;
const TEMPLATE_INNER = "(?:inputs|steps|context)(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)+";
const WHOLE_TEMPLATE_RE = new RegExp(`^\\{\\{\\s*(${TEMPLATE_INNER})\\s*\\}\\}$`);

export type ShellName = "sh" | "bash" | "zsh" | "pwsh" | "powershell" | "cmd";
export type PaneOpen = "tab" | "beside" | "below";
type PaneClose = "success" | "always";

type PaneSpec = {
  open: PaneOpen | string;
  target?: string;
  workspace?: string;
  size?: number;
  focus?: boolean;
  close?: PaneClose;
};

type RetrySpec = {
  attempts: number;
  delayMs?: number;
};

export type WhenSpec =
  | { kind: "truthy"; path: string }
  | { kind: "eq"; path: string; value: string; negate: boolean };

type RunPayload =
  | { form: "shell"; command: string; shell?: ShellName }
  | { form: "argv"; argv: string[] };

type AgentAction = {
  kind: "agent";
  prompt: string;
  using?: string;
  target?: string;
  cwd?: string;
  env?: Record<string, string>;
  pane?: PaneSpec;
  background?: boolean;
  timeoutMs?: number;
};

type RunAction = {
  kind: "run";
  payload: RunPayload;
  cwd?: string;
  env?: Record<string, string>;
  pane?: PaneSpec;
  background?: boolean;
  readyWhen?: string;
  timeoutMs?: number;
  retry?: RetrySpec;
  successCodes?: number[];
};

type HerdrAction = {
  kind: "herdr";
  method: string;
  params?: Record<string, unknown>;
  retry?: RetrySpec;
};

type WorkflowAction = {
  kind: "workflow";
  name: string;
  inputs?: Record<string, string>;
};

export type StepAction = AgentAction | RunAction | HerdrAction | WorkflowAction;

export type WorkflowStep = {
  id?: string;
  when?: WhenSpec[];
  continueOnError?: boolean;
  action: StepAction;
};

export type RecoveryAction =
  | Omit<AgentAction, "background">
  | Omit<RunAction, "background" | "retry">
  | Omit<HerdrAction, "retry">
  | WorkflowAction;

type InputType = "text" | "choice" | "profile";

export type DynamicChoice = { run: string[] };

export type InputSpec = {
  name: string;
  type: InputType;
  description?: string;
  default?: string;
  options?: string[];
  dynamicOptions?: DynamicChoice;
  when?: WhenSpec[];
  allowCustom?: boolean;
  minLength?: number;
};

export type RawInputValue =
  | "text"
  | "profile"
  | string[]
  | {
      type?: InputType;
      description?: string;
      default?: string;
      options?: string[] | DynamicChoice;
      when?: string | string[];
      allow_custom?: boolean;
      min_length?: number;
    };

export type ReturnsSpec =
  | { kind: "template"; template: string }
  | { kind: "map"; fields: Record<string, string> };

type TemplateRoot = "inputs" | "steps" | "context";

export type TemplatePath = {
  root: TemplateRoot;
  segments: string[];
};

export type TemplateNamespace = {
  inputs: Record<string, unknown>;
  steps: Record<string, unknown>;
  context: Record<string, unknown>;
};

export type LoadedWorkflow = {
  name: string;
  file: string;
  version: WorkflowFormat;
  title?: string;
  description?: string;
  hidden: boolean;
  steps: WorkflowStep[];
  inputs: InputSpec[];
  returns?: ReturnsSpec;
  onFailure?: RecoveryAction;
  repoOwned: boolean;
  needsTranscript: boolean;
};

export type WorkflowListEntry = {
  name: string;
  source: "repo" | "global";
  file: string;
  error?: string;
  hidden?: boolean;
  title?: string;
  description?: string;
  needsTranscript?: boolean;
  hasCommands?: boolean;
  sensitiveMethods?: string[];
  unresolvedChildren?: string[];
  inputs?: InputSpec[];
  repoOwned?: boolean;
  dynamicOptions?: boolean;
};

export const WORKFLOW_NAME_RULE = "workflow name must match [a-z0-9][a-z0-9-_]*";

function globalDir(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "workflows");
}

function repoDir(root: string): string {
  return join(root, ".hwf", "workflows");
}

export function assertWorkflowName(name: string): string {
  const n = name.trim();
  if (!WORKFLOW_NAME_RE.test(n)) {
    throw new WorkflowLoadError(WORKFLOW_NAME_RULE);
  }
  return n;
}

export function workflowPath(scope: "repo" | "global", repoRoot: string, name: string): string {
  const n = assertWorkflowName(name);
  return join(scope === "repo" ? repoDir(repoRoot) : globalDir(), `${n}.yaml`);
}

export async function resolveWorkflowFile(
  name: string,
  repoRoot: string,
): Promise<{ file: string; source: "repo" | "global" } | undefined> {
  const repo = workflowPath("repo", repoRoot, name);
  if (await Bun.file(repo).exists()) return { file: repo, source: "repo" };
  const global = workflowPath("global", repoRoot, name);
  if (await Bun.file(global).exists()) return { file: global, source: "global" };
  return undefined;
}

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

function malformedTemplateSnippet(text: string): string | undefined {
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

function isSensitiveContextPath(path: TemplatePath): boolean {
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

function clauseEqual(a: WhenSpec, b: WhenSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "truthy" && b.kind === "truthy") return a.path === b.path;
  if (a.kind === "eq" && b.kind === "eq") {
    return a.path === b.path && a.value === b.value && a.negate === b.negate;
  }
  return false;
}

/** True when every required clause appears among proven clauses (structural, no inference). */
export function clausesContain(proven: WhenSpec[], required: WhenSpec[]): boolean {
  return required.every((need) => proven.some((have) => clauseEqual(have, need)));
}

function isTruthyScalar(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (typeof value === "string") return value !== "";
  return true;
}

function evaluateWhenClause(when: WhenSpec, values: TemplateNamespace): boolean {
  const resolved = substituteValue(`{{${when.path}}}`, values);
  if (when.kind === "truthy") return isTruthyScalar(resolved);
  const left = renderScalar(resolved);
  return when.negate ? left !== when.value : left === when.value;
}

/** Ordered short-circuit AND over clauses. Empty/undefined is true. */
export function evaluateWhen(when: WhenSpec[] | undefined, values: TemplateNamespace): boolean {
  if (!when || when.length === 0) return true;
  for (const clause of when) {
    if (!evaluateWhenClause(clause, values)) return false;
  }
  return true;
}

const SHELLS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"] as const;
const ACTION_KEYS = ["agent", "run", "herdr", "workflow"] as const;
const WHEN_EQ_RE = new RegExp(
  `^\\{\\{\\s*(${TEMPLATE_INNER})\\s*\\}\\}\\s*(==|!=)\\s*(?:"([^"]*)"|'([^']*)')$`,
);
const ANY_MUSTACHE_RE = /\{\{/;

const identSchema = z.string().regex(IDENT_RE, "must match [a-z][a-z0-9_]{0,31}");

const durationSchema = z
  .string()
  .regex(DURATION_RE, "duration must be positive <integer><ms|s|m|h>");

const readyWhenSchema = z.string().superRefine((value, ctx) => {
  if (!value.startsWith("/") || !value.endsWith("/") || value.length < 3) {
    ctx.addIssue({
      code: "custom",
      message: "ready_when: must be a non-empty /regex/ with no flags",
    });
    return;
  }
  if (value.slice(1, -1).length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "ready_when: regex must be non-empty",
    });
    return;
  }
  try {
    new RegExp(value.slice(1, -1));
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "ready_when: invalid regex",
    });
  }
});

const PANE_OPENS = ["tab", "beside", "below"] as const;
const paneOpenSchema = z.union([
  z.enum(PANE_OPENS),
  z
    .string()
    .regex(WHOLE_TEMPLATE_RE, "pane.open must be tab, beside, below, or a whole-value template"),
]);

const paneSchema = z
  .object({
    open: paneOpenSchema.describe(
      "Where the pane goes: a new `tab`, or a `beside`/`below` split of the anchor pane. Accepts a whole-value template when the referenced input is an unconditional closed static choice of those three values.",
    ),
    target: z
      .string()
      .min(1)
      .describe("Pane to split. `beside`/`below` only; defaults to the invocation pane.")
      .optional(),
    workspace: z
      .string()
      .min(1)
      .describe("Workspace for the new tab. `tab` only; defaults to the invocation workspace.")
      .optional(),
    size: z
      .number()
      .int()
      .min(1)
      .max(99)
      .describe(
        "Percent of the anchor given to the new pane. `beside`/`below` only. herdr clamps the effective split ratio, so an extreme value is approximated rather than rejected.",
      )
      .optional(),
    focus: z.boolean().describe("Focus the new pane once it opens.").optional(),
    close: z
      .enum(["success", "always"])
      .describe(
        "Close the pane after a successful turn, or after any turn. Foreground `agent:` steps only — a `run:` step and a background step both reject it.",
      )
      .optional(),
  })
  .strict()
  .superRefine((pane, ctx) => {
    if (typeof pane.open === "string" && !(PANE_OPENS as readonly string[]).includes(pane.open)) {
      return;
    }
    if (pane.open === "tab") {
      if (pane.target !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "pane.target applies only to beside/below",
          path: ["target"],
        });
      }
      if (pane.size !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "pane.size applies only to beside/below",
          path: ["size"],
        });
      }
    } else if (pane.workspace !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "pane.workspace applies only to tab",
        path: ["workspace"],
      });
    }
  });

const retrySchema = z
  .object({
    attempts: z
      .number()
      .int()
      .min(2)
      .describe("Total attempts including the first, so at least 2."),
    delay: durationSchema.describe("Wait between attempts.").optional(),
  })
  .strict();

const envSchema = z.record(z.string(), z.string());

const dynamicChoiceSchema = z
  .object({
    run: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "argv run from the repo root to discover the options, one per line. Must be template-free and independent of earlier answers; treat it as read-only. Capped at 10s, 1,000 options, and 8 MiB.",
      ),
  })
  .strict()
  .superRefine((dc, ctx) => {
    for (let i = 0; i < dc.run.length; i++) {
      if (dc.run[i]!.includes("{{")) {
        ctx.addIssue({
          code: "custom",
          message: "dynamic choice argv rejects templates",
          path: ["run", i],
        });
      }
    }
  });

const whenClauseSchema = z.string().min(1);
const whenSchema = z.union([whenClauseSchema, z.array(whenClauseSchema).min(1)]);

const rawInputMapSchema = z
  .object({
    type: z
      .enum(["text", "choice", "profile"])
      .describe(
        "`text` accepts free-form input, `choice` picks from `options:`, `profile` picks from the configured profile names. Inferred as `choice` when `options:` is set, otherwise `text`.",
      )
      .optional(),
    description: z
      .string()
      .describe(
        "Shown in the prompt. This is the only part of the prompt line an author controls, so describe every input.",
      )
      .optional(),
    default: z
      .string()
      .describe(
        "Pre-filled answer. For a closed `choice` or `profile` it must be one of the available values.",
      )
      .optional(),
    options: z
      .union([z.array(z.string().min(1)).min(1), dynamicChoiceSchema])
      .describe("Values a `choice` offers: a static list, or `{run: argv}` to discover them.")
      .optional(),
    when: whenSchema
      .describe(
        "Guards, in order, that may reference earlier inputs. An inactive input never prompts, resolves, or exports an `HWF_` value, and supplying one fails collection.",
      )
      .optional(),
    allow_custom: z
      .boolean()
      .describe("Accept values outside `options:`, making the list suggestions. `choice` only.")
      .optional(),
    min_length: z
      .number()
      .int()
      .min(0)
      .describe("Minimum number of characters for an active answer.")
      .optional(),
  })
  .strict()
  .superRefine((map, ctx) => {
    const type = map.type ?? (map.options !== undefined ? "choice" : "text");
    if (type === "choice" && map.options === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "choice input requires options",
        path: ["options"],
      });
    }
    if ((type === "text" || type === "profile") && map.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${type} input rejects options`,
        path: ["options"],
      });
    }
    if (map.allow_custom !== undefined && type !== "choice") {
      ctx.addIssue({
        code: "custom",
        message: "allow_custom is only valid on choice inputs",
        path: ["allow_custom"],
      });
    }
  });

const rawInputValueSchema = z.union([
  z.literal("text").describe("Shorthand for a free-form text input with no other settings."),
  z.literal("profile").describe("Shorthand for a choice over the configured profile names."),
  z
    .array(z.string().min(1))
    .min(1)
    .describe("Shorthand for a closed static choice over these values."),
  rawInputMapSchema.describe("Full declaration, for a default, a guard, or discovered options."),
]);

type RefineCtx = z.core.$RefinementCtx<Record<string, unknown>>;

function actionKeysOf(step: Record<string, unknown>): string[] {
  return Object.keys(step).filter((k) => (ACTION_KEYS as readonly string[]).includes(k));
}

function refineStepUnknownKeys(
  step: Record<string, unknown>,
  action: string,
  allowed: readonly string[],
  ctx: RefineCtx,
): void {
  for (const key of Object.keys(step)) {
    if (key === action) continue;
    if (allowed.includes(key)) continue;
    ctx.addIssue({ code: "custom", message: `Unrecognized key: "${key}"`, path: [key] });
  }
}

function refineAgentCore(step: Record<string, unknown>, ctx: RefineCtx): void {
  if (typeof step.agent !== "string" || step.agent.length === 0) {
    ctx.addIssue({ code: "custom", message: "agent: prompt text is required", path: ["agent"] });
  }
  if (step.using !== undefined && step.target !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "using: and target: are mutually exclusive",
      path: ["using"],
    });
  }
}

function refineAgentStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  refineStepUnknownKeys(
    step,
    "agent",
    [
      "id",
      "when",
      "continue_on_error",
      "using",
      "target",
      "cwd",
      "env",
      "pane",
      "background",
      "timeout",
    ],
    ctx,
  );
  refineAgentCore(step, ctx);
  if (step.target !== undefined) {
    for (const key of ["pane", "cwd", "env"] as const) {
      if (step[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `target: rejects ${key}:`,
          path: [key],
        });
      }
    }
  }
  if (step.background === true && step.timeout !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "background: rejects timeout",
      path: ["timeout"],
    });
  }
  if (step.background === true && step.pane && typeof step.pane === "object") {
    const pane = step.pane as Record<string, unknown>;
    if (pane.close !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "background: rejects pane.close",
        path: ["pane", "close"],
      });
    }
  }
}

function refineRunPayload(step: Record<string, unknown>, ctx: RefineCtx): void {
  const run = step.run;
  const isArgv = Array.isArray(run);
  const isShell = typeof run === "string";
  if (!isArgv && !isShell) {
    ctx.addIssue({
      code: "custom",
      message: "run: must be a non-empty string or string list",
      path: ["run"],
    });
  }
  if (isShell && run.length === 0) {
    ctx.addIssue({ code: "custom", message: "run: must be non-empty", path: ["run"] });
  }
  if (isArgv) {
    if (run.length === 0) {
      ctx.addIssue({ code: "custom", message: "run: argv must be non-empty", path: ["run"] });
    }
    if (!run.every((v) => typeof v === "string")) {
      ctx.addIssue({
        code: "custom",
        message: "run: argv elements must be strings",
        path: ["run"],
      });
    }
    if (step.shell !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "argv form does not use a shell",
        path: ["shell"],
      });
    }
  }
  if (isShell && ANY_MUSTACHE_RE.test(run)) {
    ctx.addIssue({
      code: "custom",
      message:
        "templates are not allowed in shell command text — use argv form or explicit env values",
      path: ["run"],
    });
  }
  if (step.shell !== undefined && typeof step.shell === "string") {
    if (!(SHELLS as readonly string[]).includes(step.shell)) {
      ctx.addIssue({
        code: "custom",
        message: `shell: must be one of ${SHELLS.join(", ")}`,
        path: ["shell"],
      });
    }
  }
}

function refineRunLifecycle(step: Record<string, unknown>, ctx: RefineCtx): void {
  if (step.background === true && step.ready_when !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "background: and ready_when: are mutually exclusive",
      path: ["ready_when"],
    });
  }
  if (step.background === true && step.timeout !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "background: rejects timeout",
      path: ["timeout"],
    });
  }
  if (step.background === true && step.retry !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "background: rejects retry",
      path: ["retry"],
    });
  }
  if (step.pane !== undefined) {
    if (step.background !== true && step.ready_when === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "placed run requires background: or ready_when:",
        path: ["pane"],
      });
    }
    if (typeof step.pane === "object" && step.pane && "close" in step.pane) {
      ctx.addIssue({
        code: "custom",
        message: "run: rejects pane.close",
        path: ["pane", "close"],
      });
    }
  }
  if (step.ready_when !== undefined) {
    if (step.pane === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "ready_when: requires pane:",
        path: ["ready_when"],
      });
    }
    if (step.timeout === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "ready_when: requires timeout",
        path: ["timeout"],
      });
    }
    if (step.retry !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "ready_when: rejects retry",
        path: ["retry"],
      });
    }
  }
  if (step.background === true && step.pane === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "background: requires pane:",
      path: ["background"],
    });
  }
  if (step.success_codes !== undefined) {
    if (step.pane !== undefined || step.background === true || step.ready_when !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "success_codes: applies only to blocking local run:",
        path: ["success_codes"],
      });
    }
  }
}

function refineSuccessCodes(step: Record<string, unknown>, ctx: RefineCtx): void {
  const codes = step.success_codes;
  if (codes === undefined) return;
  if (!Array.isArray(codes) || codes.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "success_codes: must be a non-empty list of integers",
      path: ["success_codes"],
    });
    return;
  }
  const seen = new Set<number>();
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (typeof code !== "number" || !Number.isInteger(code)) {
      ctx.addIssue({
        code: "custom",
        message: "success_codes: must be a non-empty list of integers",
        path: ["success_codes", i],
      });
      continue;
    }
    if (seen.has(code)) {
      ctx.addIssue({
        code: "custom",
        message: `success_codes: duplicate exit code ${code}`,
        path: ["success_codes", i],
      });
    }
    seen.add(code);
  }
}

function refineRunStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  refineStepUnknownKeys(
    step,
    "run",
    [
      "id",
      "when",
      "continue_on_error",
      "shell",
      "cwd",
      "env",
      "pane",
      "background",
      "ready_when",
      "timeout",
      "retry",
      "success_codes",
    ],
    ctx,
  );
  refineRunPayload(step, ctx);
  refineRunLifecycle(step, ctx);
  refineSuccessCodes(step, ctx);
}

function refineHerdrStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  refineStepUnknownKeys(step, "herdr", ["id", "when", "continue_on_error", "params", "retry"], ctx);
  if (typeof step.herdr !== "string" || step.herdr.length === 0) {
    ctx.addIssue({ code: "custom", message: "herdr: method is required", path: ["herdr"] });
  }
}

function refineWorkflowStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  refineStepUnknownKeys(step, "workflow", ["id", "when", "continue_on_error", "inputs"], ctx);
  if (typeof step.workflow !== "string" || step.workflow.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "workflow: name is required",
      path: ["workflow"],
    });
  }
}

function refineRawStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  const actions = actionKeysOf(step);
  if (actions.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "step has no action key (expected agent, run, herdr, or workflow)",
    });
    return;
  }
  if (actions.length > 1) {
    ctx.addIssue({
      code: "custom",
      message: `step has multiple action keys: ${actions.join(", ")}`,
    });
    return;
  }
  const action = actions[0]!;
  if (action === "agent") refineAgentStep(step, ctx);
  else if (action === "run") refineRunStep(step, ctx);
  else if (action === "herdr") refineHerdrStep(step, ctx);
  else refineWorkflowStep(step, ctx);
}

const sharedActionFields = {
  agent: z
    .string()
    .describe(
      "Action: prompt text for an agent. Pair with `using:` to start a new agent or `target:` to address a running one. The result is `{response, agent, pane_id}`; the default turn timeout is 30 minutes.",
    )
    .optional(),
  using: z
    .string()
    .min(1)
    .describe(
      "Profile that starts a new managed agent for this prompt. Mutually exclusive with `target:`; omit both to use the default profile.",
    )
    .optional(),
  target: z
    .string()
    .min(1)
    .describe(
      "Existing agent name or pane ID to prompt, which must be idle or done. On a step it rejects `pane:`, `cwd:`, and `env:` because the agent already has a pane. Mutually exclusive with `using:`.",
    )
    .optional(),
  run: z
    .union([z.string().min(1), z.array(z.string()).min(1)])
    .describe(
      "Action: a command. A list is argv with no shell; a string runs through `shell:`. Inputs are exported as `HWF_<name>`. A blocking local run results in `{stdout, stderr, exit_code, failed}`; a placed run results in its readiness payload, and a background run has no result to reference.",
    )
    .optional(),
  shell: z
    .enum(SHELLS)
    .describe(
      "Shell for a string `run:`, defaulting to `sh`. The argv form rejects it, since argv runs without a shell.",
    )
    .optional(),
  herdr: z
    .string()
    .describe(
      "Action: a herdr socket method such as `notification.show`. Nothing is filled in automatically, and a denied method fails at load. The result is the complete herdr payload.",
    )
    .optional(),
  params: z
    .record(z.string(), z.unknown())
    .describe("Arguments for the `herdr:` method.")
    .optional(),
  workflow: z
    .string()
    .describe(
      "Action: a child workflow, run in isolation. Its `returns:` becomes this step's result; its own `on_failure` does not run under a parent.",
    )
    .optional(),
  inputs: z
    .record(z.string(), z.string())
    .describe("Values passed to the child workflow, keyed by its declared input names.")
    .optional(),
  cwd: z
    .string()
    .min(1)
    .describe(
      "Working directory, defaulting to the invocation working directory. `agent:` and `run:` steps only; `herdr:` and `workflow:` reject it.",
    )
    .optional(),
  env: envSchema
    .describe(
      "Extra environment variables. `agent:` and `run:` steps only. The `HWF_` prefix is reserved for exported inputs: a `run:` step fails on one at runtime rather than at load, and an agent step passes it through.",
    )
    .optional(),
  pane: paneSchema
    .describe(
      "Place this step in a herdr pane instead of running it invisibly. `agent:` and `run:` steps only. A placed `run:` must also set `background:` or `ready_when:`, and rejects `pane.close`.",
    )
    .optional(),
  ready_when: readyWhenSchema
    .describe(
      "`/regex/`, no flags, matched against recent pane output to decide the step is ready. `run:` only, and requires both `pane:` and `timeout:`. Matches text already on screen, and does not detect process exit.",
    )
    .optional(),
  timeout: durationSchema
    .describe(
      "Time limit for an `agent:` or `run:` step; `herdr:` and `workflow:` reject it. Omitting it leaves a local `run:` uncapped, but an agent turn still falls back to 30 minutes, and a placed `run:` with `ready_when:` requires it.",
    )
    .optional(),
  success_codes: z
    .array(z.number().int())
    .min(1)
    .describe(
      "Exit codes counted as success instead of the default `[0]`. Blocking local `run:` steps only — a placed, background, or `on_failure` run rejects it, as do the other three actions.",
    )
    .optional(),
};

const rawStepSchema = z
  .object({
    id: identSchema
      .describe("Name this step so later steps can read `{{steps.<id>.field}}` from its result.")
      .optional(),
    when: whenSchema
      .describe(
        "Guard: one clause, or an ordered list evaluated as a short-circuit AND. A clause is a truthiness check or an `==`/`!=` comparison against a quoted string. A false result skips the step.",
      )
      .optional(),
    continue_on_error: z
      .boolean()
      .describe(
        "Tolerate an ordinary failure here: later steps continue and `on_failure` is suppressed, though the run still exits nonzero. A hard failure — a timeout, a capture overflow, or a spawn error — aborts anyway, and lost herdr coordination aborts before this is consulted.",
      )
      .optional(),
    ...sharedActionFields,
    background: z
      .boolean()
      .describe(
        "Start the step and move on without waiting, so it produces no result to reference. The process is pane-owned and survives client detach, but not a herdr server restart. Rejects `timeout:`, `retry:`, and `pane.close`; a background `run:` also requires `pane:`.",
      )
      .optional(),
    retry: retrySchema
      .describe(
        "Retry a failed attempt. `run:` and `herdr:` steps only, and never on a background step or in `on_failure`.",
      )
      .optional(),
  })
  .passthrough()
  .superRefine((step, ctx) => refineRawStep(step, ctx));

function refineRecoveryStep(step: Record<string, unknown>, ctx: RefineCtx): void {
  for (const key of ["id", "when", "continue_on_error", "background", "retry"] as const) {
    if (step[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `on_failure rejects ${key}:`,
        path: [key],
      });
    }
  }
  const actions = actionKeysOf(step);
  if (actions.length !== 1) {
    refineRawStep(step, ctx);
    return;
  }
  const action = actions[0]!;
  if (action === "agent") {
    refineStepUnknownKeys(step, "agent", ["using", "target", "cwd", "env", "pane", "timeout"], ctx);
    refineAgentCore(step, ctx);
  } else if (action === "run") {
    refineStepUnknownKeys(
      step,
      "run",
      ["shell", "cwd", "env", "pane", "ready_when", "timeout"],
      ctx,
    );
    refineRunStep(
      {
        ...step,
        background: undefined,
        retry: undefined,
        continue_on_error: undefined,
        id: undefined,
        when: undefined,
      },
      ctx,
    );
  } else if (action === "herdr") {
    refineStepUnknownKeys(step, "herdr", ["params"], ctx);
    if (typeof step.herdr !== "string" || step.herdr.length === 0) {
      ctx.addIssue({ code: "custom", message: "herdr: method is required", path: ["herdr"] });
    }
  } else {
    refineStepUnknownKeys(step, "workflow", ["inputs"], ctx);
    if (typeof step.workflow !== "string" || step.workflow.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "workflow: name is required",
        path: ["workflow"],
      });
    }
  }
}

// The step-only keys are accepted here only so the refinement can name each one it rejects.
const REJECTED_BY_RECOVERY = "Not valid on `on_failure`, which runs once and is never guarded.";

const recoveryStepSchema = z
  .object({
    ...sharedActionFields,
    id: z.unknown().describe(REJECTED_BY_RECOVERY).optional(),
    when: z.unknown().describe(REJECTED_BY_RECOVERY).optional(),
    continue_on_error: z.unknown().describe(REJECTED_BY_RECOVERY).optional(),
    background: z.unknown().describe(REJECTED_BY_RECOVERY).optional(),
    retry: z.unknown().describe(REJECTED_BY_RECOVERY).optional(),
  })
  .passthrough()
  .superRefine((step, ctx) => refineRecoveryStep(step, ctx));

const returnsSchema = z.union([
  z.string().min(1).describe("A single template, which becomes the whole result."),
  z
    .record(identSchema, z.string().min(1))
    .refine((m) => Object.keys(m).length > 0, {
      message: "returns: map must be non-empty",
    })
    .describe("Named templates, which become the fields of the result."),
]);

export const rawWorkflowSchema = z
  .object({
    version: z
      .string()
      .superRefine((value, ctx) => {
        if (value !== WORKFLOW_FORMAT) {
          ctx.addIssue({
            code: "custom",
            message: `unsupported workflow format '${value}' — supported format is ${WORKFLOW_FORMAT}; rewrite the workflow or upgrade herdr-workflows`,
          });
        }
      })
      .describe(
        `Workflow format version. Must be \`${WORKFLOW_FORMAT}\`; any other value fails the load with rewrite-or-upgrade guidance.`,
      ),
    title: z
      .string()
      .describe(
        "Picker label. Defaults to the humanized filename, and is truncated to the picker row width.",
      )
      .optional(),
    description: z
      .string()
      .describe("Picker subtitle, wrapped or truncated to at most two rows.")
      .optional(),
    hidden: z
      .boolean()
      .describe("Hide from the picker. `hwf run` still launches the workflow.")
      .optional(),
    inputs: z
      .record(identSchema, rawInputValueSchema)
      .describe(
        "Values collected before the run, keyed by a name matching `[a-z][a-z0-9_]{0,31}`. Only the entry workflow prompts, in declaration order; a child receives values from its parent's step `inputs:`.",
      )
      .optional(),
    returns: returnsSchema
      .describe("What a parent's `workflow:` step gets as this workflow's result.")
      .optional(),
    on_failure: recoveryStepSchema
      .describe(
        "Recovery action, run once after the first non-tolerated failure. Entry workflow only, and `{{context.error}}` is available. Rejects `id`, `when`, `continue_on_error`, `background`, `retry`, and `success_codes`. Skipped entirely when herdr coordination is lost.",
      )
      .optional(),
    steps: z
      .array(rawStepSchema)
      .min(1)
      .describe(
        "Steps in execution order. Each uses exactly one of `agent:`, `run:`, `herdr:`, or `workflow:`.",
      ),
  })
  .strict();

export type RawStep = z.infer<typeof rawStepSchema>;
export type RawWorkflowDoc = z.infer<typeof rawWorkflowSchema>;
/** Schema field order for dump — derived from `rawStepSchema.shape`. */
export const rawStepKeyOrder = Object.keys(rawStepSchema.shape);

export type RawWorkflow = {
  version: typeof WORKFLOW_FORMAT;
  title?: string;
  description?: string;
  hidden?: boolean;
  inputs?: Record<string, RawInputValue>;
  returns?: ReturnsSpec;
  onFailure?: RecoveryAction;
  steps: WorkflowStep[];
};

function formatIssue(file: string, issue: z.core.$ZodIssue): string {
  const path = issue.path;
  let step: number | undefined;
  let key: string | undefined;
  if (path[0] === "steps" && typeof path[1] === "number") {
    step = path[1] + 1;
    if (path.length >= 3) key = String(path[2]);
  } else if (path[0] === "on_failure") {
    key = path.length >= 2 ? `on_failure.${String(path[1])}` : "on_failure";
  } else if (path[0] === "inputs" && typeof path[1] === "string") {
    key =
      path.length >= 3
        ? `inputs.${path[1]}.${path.slice(2).map(String).join(".")}`
        : `inputs.${path[1]}`;
  } else if (path.length > 0) {
    key = String(path[0]);
  }
  let message = issue.message;
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as { keys: string[] }).keys;
    message = keys.map((k) => `Unrecognized key: "${k}"`).join("; ");
    key = key ?? keys[0];
  }
  return positioned(file, step, key, message);
}

export function parseDurationMs(text: string): number {
  const m = DURATION_RE.exec(text);
  if (!m) {
    throw new WorkflowLoadError(`duration must be positive <integer><ms|s|m|h> (got '${text}')`);
  }
  const n = Number(m[1]);
  const unit = m[2]!;
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return n * 3_600_000;
}

function assertValidTemplates(
  file: string,
  step: number | undefined,
  key: string,
  text: string,
): void {
  const bad = malformedTemplateSnippet(text);
  if (bad === undefined) return;
  bail(file, step, key, `invalid template '${bad}' — expected {{inputs|steps|context.<path>}}`);
}

function assertTemplatesInValue(
  file: string,
  step: number | undefined,
  key: string,
  value: unknown,
): void {
  walkValueStrings(value, key, (text, path) => {
    assertValidTemplates(file, step, path, text);
    return text;
  });
}

export function parseWhenClause(
  file: string,
  stepIndex: number | undefined,
  key: string,
  value: string,
): WhenSpec {
  if (ANY_MUSTACHE_RE.test(value)) {
    assertValidTemplates(file, stepIndex, key, value);
  }
  const eq = WHEN_EQ_RE.exec(value);
  if (eq) {
    return {
      kind: "eq",
      path: eq[1]!,
      value: eq[3] ?? eq[4] ?? "",
      negate: eq[2] === "!=",
    };
  }
  const truthy = WHOLE_TEMPLATE_RE.exec(value);
  if (truthy) {
    return { kind: "truthy", path: truthy[1]! };
  }
  bail(
    file,
    stepIndex,
    key,
    "when: must be a whole-value template or '{{path}} == \"value\"' / '!=' comparison",
  );
}

function parseWhenClauses(
  file: string,
  stepIndex: number | undefined,
  key: string,
  value: string | string[],
): WhenSpec[] {
  const clauses = Array.isArray(value) ? value : [value];
  return clauses.map((clause, i) =>
    parseWhenClause(file, stepIndex, Array.isArray(value) ? `${key}[${i}]` : key, clause),
  );
}

function parseRetry(value: { attempts: number; delay?: string }): RetrySpec {
  return {
    attempts: value.attempts,
    delayMs: value.delay !== undefined ? parseDurationMs(value.delay) : undefined,
  };
}

function parsePane(pane: z.infer<typeof paneSchema>): PaneSpec {
  return {
    open: pane.open,
    ...(pane.target !== undefined ? { target: pane.target } : {}),
    ...(pane.workspace !== undefined ? { workspace: pane.workspace } : {}),
    ...(pane.size !== undefined ? { size: pane.size } : {}),
    ...(pane.focus !== undefined ? { focus: pane.focus } : {}),
    ...(pane.close !== undefined ? { close: pane.close } : {}),
  };
}

function parseRunPayload(file: string, stepIndex: number, step: RawStep): RunPayload {
  const value = step.run;
  if (Array.isArray(value)) {
    return { form: "argv", argv: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, "run", "run: must be a string or argv list");
  }
  return step.shell
    ? { form: "shell", command: value, shell: step.shell as ShellName }
    : { form: "shell", command: value };
}

function parseReturns(file: string, value: string | Record<string, string>): ReturnsSpec {
  if (typeof value === "string") {
    assertValidTemplates(file, undefined, "returns", value);
    if (!isWholeValueTemplate(value)) {
      bail(file, undefined, "returns", "returns: must be a whole-value template");
    }
    return { kind: "template", template: value };
  }
  for (const [name, template] of Object.entries(value)) {
    assertValidTemplates(file, undefined, `returns.${name}`, template);
    if (!isWholeValueTemplate(template)) {
      bail(file, undefined, `returns.${name}`, "returns: must be a whole-value template");
    }
  }
  return { kind: "map", fields: value };
}

function optionalCwdEnvPane(step: {
  cwd?: string;
  env?: Record<string, string>;
  pane?: z.infer<typeof paneSchema>;
}): { cwd?: string; env?: Record<string, string>; pane?: PaneSpec } {
  return {
    ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
    ...(step.env !== undefined ? { env: step.env } : {}),
    ...(step.pane !== undefined ? { pane: parsePane(step.pane) } : {}),
  };
}

function assertActionTemplates(
  file: string,
  stepIndex: number | undefined,
  step: RawStep,
  keyPrefix?: string,
): void {
  const key = (name: string) => (keyPrefix ? `${keyPrefix}.${name}` : name);
  if (step.agent !== undefined) {
    assertValidTemplates(file, stepIndex, key("agent"), step.agent);
    if (step.using !== undefined) assertValidTemplates(file, stepIndex, key("using"), step.using);
    if (step.target !== undefined)
      assertValidTemplates(file, stepIndex, key("target"), step.target);
  }
  if (Array.isArray(step.run)) {
    step.run.forEach((el, i) => assertValidTemplates(file, stepIndex, key(`run[${i}]`), el));
  }
  if (step.cwd !== undefined) assertValidTemplates(file, stepIndex, key("cwd"), step.cwd);
  if (step.env !== undefined) assertTemplatesInValue(file, stepIndex, key("env"), step.env);
  if (step.pane?.target !== undefined) {
    assertValidTemplates(file, stepIndex, key("pane.target"), step.pane.target);
  }
  if (step.pane?.workspace !== undefined) {
    assertValidTemplates(file, stepIndex, key("pane.workspace"), step.pane.workspace);
  }
  if (typeof step.pane?.open === "string" && step.pane.open.includes("{{")) {
    assertValidTemplates(file, stepIndex, key("pane.open"), step.pane.open);
  }
  if (step.params !== undefined)
    assertTemplatesInValue(file, stepIndex, key("params"), step.params);
  if (step.inputs !== undefined)
    assertTemplatesInValue(file, stepIndex, key("inputs"), step.inputs);
}

function toAction(
  file: string,
  stepIndex: number | undefined,
  step: RawStep,
  keyPrefix?: string,
): StepAction {
  assertActionTemplates(file, stepIndex, step, keyPrefix);
  if (step.agent !== undefined) {
    return {
      kind: "agent",
      prompt: step.agent,
      ...(step.using !== undefined ? { using: step.using } : {}),
      ...(step.target !== undefined ? { target: step.target } : {}),
      ...optionalCwdEnvPane(step),
      ...(step.background === true ? { background: true } : {}),
      ...(step.timeout !== undefined ? { timeoutMs: parseDurationMs(step.timeout) } : {}),
    };
  }
  if (step.run !== undefined) {
    return {
      kind: "run",
      payload: parseRunPayload(file, stepIndex ?? 0, step),
      ...optionalCwdEnvPane(step),
      ...(step.background === true ? { background: true } : {}),
      ...(step.ready_when !== undefined ? { readyWhen: step.ready_when.slice(1, -1) } : {}),
      ...(step.timeout !== undefined ? { timeoutMs: parseDurationMs(step.timeout) } : {}),
      ...(step.retry !== undefined ? { retry: parseRetry(step.retry) } : {}),
      ...(step.success_codes !== undefined ? { successCodes: step.success_codes } : {}),
    };
  }
  if (step.herdr !== undefined) {
    const params = step.params;
    // Selector presence is key-based; template values do not waive it.
    const err = validateHerdrInvocation(step.herdr, params);
    if (err) bail(file, stepIndex, keyPrefix ? `${keyPrefix}.herdr` : "herdr", err);
    return {
      kind: "herdr",
      method: step.herdr,
      ...(params !== undefined ? { params } : {}),
      ...(step.retry !== undefined ? { retry: parseRetry(step.retry) } : {}),
    };
  }
  if (step.workflow !== undefined) {
    return {
      kind: "workflow",
      name: step.workflow,
      ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
    };
  }
  bail(file, stepIndex, keyPrefix, "step has no action key");
}

function toStep(file: string, stepIndex: number, step: RawStep): WorkflowStep {
  return {
    ...(step.id !== undefined ? { id: step.id } : {}),
    ...(step.when !== undefined
      ? { when: parseWhenClauses(file, stepIndex, "when", step.when) }
      : {}),
    ...(step.continue_on_error === true ? { continueOnError: true } : {}),
    action: toAction(file, stepIndex, step),
  };
}

function toRecovery(file: string, step: z.infer<typeof recoveryStepSchema>): RecoveryAction {
  return toAction(file, undefined, step as RawStep, "on_failure") as RecoveryAction;
}

export function parseRaw(file: string, text: string): RawWorkflow {
  return parseRawWithDoc(file, text).workflow;
}

export function parseRawWithDoc(
  file: string,
  text: string,
): { workflow: RawWorkflow; doc: RawWorkflowDoc } {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (error) {
    bail(file, undefined, undefined, error instanceof Error ? error.message : String(error));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    bail(file, undefined, undefined, "workflow document must be a mapping");
  }
  const doc = data as Record<string, unknown>;
  if (!("version" in doc)) {
    bail(
      file,
      undefined,
      "version",
      `version is required — supported format is ${WORKFLOW_FORMAT}`,
    );
  }
  if (!("steps" in doc)) {
    bail(file, undefined, "steps", "steps is required");
  }
  const result = rawWorkflowSchema.safeParse(data);
  if (!result.success) {
    throw new WorkflowLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  const raw = result.data;
  return {
    doc: raw,
    workflow: {
      version: WORKFLOW_FORMAT,
      ...(raw.title !== undefined ? { title: raw.title } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(raw.hidden !== undefined ? { hidden: raw.hidden } : {}),
      ...(raw.inputs !== undefined ? { inputs: raw.inputs as Record<string, RawInputValue> } : {}),
      ...(raw.returns !== undefined ? { returns: parseReturns(file, raw.returns) } : {}),
      ...(raw.on_failure !== undefined ? { onFailure: toRecovery(file, raw.on_failure) } : {}),
      steps: raw.steps.map((step, i) => toStep(file, i + 1, step)),
    },
  };
}

/** Allowed methods that still deserve a visible authoring warning. */
const SENSITIVE_ALLOWED = new Set([
  "pane.close",
  "tab.close",
  "workspace.close",
  "agent.send_keys",
  "pane.send_keys",
  "pane.send_text",
  "pane.send_input",
  "worktree.create",
  "layout.apply",
]);

export type WorkflowSensitivity = {
  hasCommands: boolean;
  hasTranscript: boolean;
  sensitiveMethods: string[];
  unresolvedChildren: string[];
};

export function humanizeWorkflowName(name: string): string {
  const spaced = name.replace(/[-_]+/g, " ").trim();
  if (!spaced) return name;
  return spaced.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function workflowDisplayTitle(name: string, title?: string): string {
  return title?.trim() || humanizeWorkflowName(name);
}

function isSensitiveHerdrMethod(method: string): boolean {
  const entry = HERDR_METHOD_BY_NAME.get(method);
  if (entry && !entry.allowed) return true;
  return SENSITIVE_ALLOWED.has(method);
}

function collectHerdrMethods(steps: WorkflowStep[], onFailure?: RecoveryAction): string[] {
  const methods: string[] = [];
  const visit = (action: WorkflowStep["action"] | RecoveryAction) => {
    if (action.kind === "herdr") methods.push(action.method);
  };
  for (const step of steps) visit(step.action);
  if (onFailure) visit(onFailure);
  return methods;
}

function childWorkflowNames(steps: WorkflowStep[], onFailure?: RecoveryAction): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (step.action.kind === "workflow") names.push(step.action.name);
  }
  if (onFailure?.kind === "workflow") names.push(onFailure.name);
  return names;
}

function analyzeWorkflowSensitivity(
  steps: WorkflowStep[],
  returns?: ReturnsSpec,
  onFailure?: RecoveryAction,
): WorkflowSensitivity {
  const hasCommands = steps.some((s) => s.action.kind === "run") || onFailure?.kind === "run";
  const hasTranscript = workflowTemplateRefs(steps, returns, onFailure).some(
    isSensitiveContextPath,
  );
  const sensitiveMethods = [
    ...new Set(collectHerdrMethods(steps, onFailure).filter(isSensitiveHerdrMethod)),
  ].sort();
  return { hasCommands, hasTranscript, sensitiveMethods, unresolvedChildren: [] };
}

export function analyzeRawWorkflow(raw: RawWorkflow): WorkflowSensitivity {
  return analyzeWorkflowSensitivity(raw.steps, raw.returns, raw.onFailure);
}

/** `workflow:` names referenced by a single shared payload (never included in the payload itself). */
export function referencedWorkflowChildren(raw: RawWorkflow): string[] {
  return [...new Set(childWorkflowNames(raw.steps, raw.onFailure))].sort();
}

export function mergeSensitivity(into: WorkflowSensitivity, from: WorkflowSensitivity): void {
  into.hasCommands ||= from.hasCommands;
  into.hasTranscript ||= from.hasTranscript;
  for (const method of from.sensitiveMethods) {
    if (!into.sensitiveMethods.includes(method)) into.sensitiveMethods.push(method);
  }
  for (const name of from.unresolvedChildren) {
    if (!into.unresolvedChildren.includes(name)) into.unresolvedChildren.push(name);
  }
}

/**
 * Aggregate sensitivity across resolvable `workflow:` children (and recovery), with cycle
 * safety. Unresolvable children are listed rather than treated as clean.
 */
export async function analyzeResolvedSensitivity(
  workflow: {
    name: string;
    steps: WorkflowStep[];
    returns?: ReturnsSpec;
    onFailure?: RecoveryAction;
  },
  repoRoot: string,
  stack: string[] = [],
): Promise<WorkflowSensitivity> {
  const local = analyzeWorkflowSensitivity(workflow.steps, workflow.returns, workflow.onFailure);
  if (stack.includes(workflow.name)) return local;

  const nextStack = [...stack, workflow.name];
  const aggregated: WorkflowSensitivity = {
    hasCommands: local.hasCommands,
    hasTranscript: local.hasTranscript,
    sensitiveMethods: [...local.sensitiveMethods],
    unresolvedChildren: [],
  };

  for (const childName of childWorkflowNames(workflow.steps, workflow.onFailure)) {
    if (nextStack.includes(childName)) continue;
    const resolved = await resolveWorkflowFile(childName, repoRoot);
    if (!resolved) {
      if (!aggregated.unresolvedChildren.includes(childName)) {
        aggregated.unresolvedChildren.push(childName);
      }
      continue;
    }
    try {
      const raw = parseRaw(resolved.file, await Bun.file(resolved.file).text());
      const child = await analyzeResolvedSensitivity(
        {
          name: childName,
          steps: raw.steps,
          returns: raw.returns,
          onFailure: raw.onFailure,
        },
        repoRoot,
        nextStack,
      );
      mergeSensitivity(aggregated, child);
    } catch {
      if (!aggregated.unresolvedChildren.includes(childName)) {
        aggregated.unresolvedChildren.push(childName);
      }
    }
  }

  aggregated.sensitiveMethods.sort();
  aggregated.unresolvedChildren.sort();
  return aggregated;
}

export async function analyzeYamlTree(
  file: string,
  body: string,
  name: string,
  repoRoot: string,
): Promise<WorkflowSensitivity> {
  const raw = parseRaw(file, body);
  return analyzeResolvedSensitivity(
    { name, steps: raw.steps, returns: raw.returns, onFailure: raw.onFailure },
    repoRoot,
  );
}

export function sensitivityLabels(flags: WorkflowSensitivity): string[] {
  const labels: string[] = [];
  if (flags.hasCommands) labels.push("commands");
  if (flags.hasTranscript) labels.push("transcript");
  for (const method of flags.sensitiveMethods) labels.push(`herdr:${method}`);
  for (const name of flags.unresolvedChildren) labels.push(`unresolved:${name}`);
  return labels;
}

export function formatSensitivityBanner(flags: WorkflowSensitivity, label = "sensitive"): string {
  const labels = sensitivityLabels(flags);
  if (labels.length === 0) return "";
  return `⚠ ${label}: ${labels.join(" · ")}\n`;
}
