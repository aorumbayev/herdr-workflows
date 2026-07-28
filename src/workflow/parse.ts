import { z } from "zod";
import { assertFocusPolicyAtLoad } from "../herdr-policy";
import { validateMethodParams } from "../herdr-methods";
import {
  bail,
  DURATION_RE,
  IDENT_RE,
  positioned,
  WORKFLOW_FORMAT,
  WorkflowLoadError,
  type PaneSpec,
  type RawInputValue,
  type RecoveryAction,
  type ReturnsSpec,
  type RetrySpec,
  type RunPayload,
  type ShellName,
  type StepAction,
  type TemplateNamespace,
  type TemplatePath,
  type TemplateRoot,
  type WhenSpec,
  type WorkflowStep,
} from "./types";

const SHELLS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"] as const;
const ACTION_KEYS = ["agent", "run", "herdr", "workflow"] as const;
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TEMPLATE_INNER = "(?:inputs|steps|context)(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)+";
const TEMPLATE_PATH_RE = new RegExp(`^${TEMPLATE_INNER}$`);
const TEMPLATE_FIND_RE = new RegExp(`\\{\\{\\s*(${TEMPLATE_INNER})\\s*\\}\\}`, "g");
const WHOLE_TEMPLATE_RE = new RegExp(`^\\{\\{\\s*(${TEMPLATE_INNER})\\s*\\}\\}$`);
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

const paneSchema = z
  .object({
    open: z.enum(["tab", "beside", "below"]),
    target: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    size: z.number().int().min(1).max(99).optional(),
    focus: z.boolean().optional(),
    close: z.enum(["success", "always"]).optional(),
  })
  .strict()
  .superRefine((pane, ctx) => {
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
    attempts: z.number().int().min(2),
    delay: durationSchema.optional(),
  })
  .strict();

const envSchema = z.record(z.string(), z.string());

const dynamicChoiceSchema = z
  .object({
    run: z.array(z.string().min(1)).min(1),
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

const rawInputMapSchema = z
  .object({
    type: z.enum(["text", "choice", "profile"]).optional(),
    description: z.string().optional(),
    default: z.string().optional(),
    options: z.union([z.array(z.string().min(1)).min(1), dynamicChoiceSchema]).optional(),
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
  });

const rawInputValueSchema = z.union([
  z.literal("text"),
  z.literal("profile"),
  z.array(z.string().min(1)).min(1),
  rawInputMapSchema,
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
    ],
    ctx,
  );
  refineRunPayload(step, ctx);
  refineRunLifecycle(step, ctx);
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
  agent: z.string().optional(),
  using: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  run: z.union([z.string().min(1), z.array(z.string()).min(1)]).optional(),
  shell: z.enum(SHELLS).optional(),
  herdr: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  workflow: z.string().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: envSchema.optional(),
  pane: paneSchema.optional(),
  ready_when: readyWhenSchema.optional(),
  timeout: durationSchema.optional(),
};

const rawStepSchema = z
  .object({
    id: identSchema.optional(),
    when: z.string().min(1).optional(),
    continue_on_error: z.boolean().optional(),
    ...sharedActionFields,
    background: z.boolean().optional(),
    retry: retrySchema.optional(),
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

const recoveryStepSchema = z
  .object({
    ...sharedActionFields,
    id: z.unknown().optional(),
    when: z.unknown().optional(),
    continue_on_error: z.unknown().optional(),
    background: z.unknown().optional(),
    retry: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((step, ctx) => refineRecoveryStep(step, ctx));

const returnsSchema = z.union([
  z.string().min(1),
  z.record(identSchema, z.string().min(1)).refine((m) => Object.keys(m).length > 0, {
    message: "returns: map must be non-empty",
  }),
]);

export const rawWorkflowSchema = z
  .object({
    version: z.string().superRefine((value, ctx) => {
      if (value !== WORKFLOW_FORMAT) {
        ctx.addIssue({
          code: "custom",
          message: `unsupported workflow format '${value}' — supported format is ${WORKFLOW_FORMAT}; rewrite the workflow or upgrade herdr-workflows`,
        });
      }
    }),
    title: z.string().optional(),
    description: z.string().optional(),
    hidden: z.boolean().optional(),
    inputs: z.record(identSchema, rawInputValueSchema).optional(),
    returns: returnsSchema.optional(),
    on_failure: recoveryStepSchema.optional(),
    steps: z.array(rawStepSchema).min(1),
  })
  .strict();

export type RawStep = z.infer<typeof rawStepSchema>;
export type RawWorkflowDoc = z.infer<typeof rawWorkflowSchema>;

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
  if (typeof value === "string") {
    assertValidTemplates(file, step, key, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertTemplatesInValue(file, step, `${key}[${i}]`, item));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertTemplatesInValue(file, step, `${key}.${k}`, v);
    }
  }
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

function walkParams(value: unknown, mapText: (text: string) => unknown): unknown {
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
  ns: TemplateNamespace,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  return walkParams(params, (text) => substituteValue(text, ns)) as Record<string, unknown>;
}

function parseWhen(file: string, stepIndex: number, value: string): WhenSpec {
  if (ANY_MUSTACHE_RE.test(value)) {
    assertValidTemplates(file, stepIndex, "when", value);
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
    "when",
    "when: must be a whole-value template or '{{path}} == \"value\"' / '!=' comparison",
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
    };
  }
  if (step.herdr !== undefined) {
    const params = step.params;
    const err = validateMethodParams(step.herdr, params);
    if (err) bail(file, stepIndex, keyPrefix ? `${keyPrefix}.herdr` : "herdr", err);
    const policy = assertFocusPolicyAtLoad(step.herdr, params);
    if (policy) bail(file, stepIndex, keyPrefix ? `${keyPrefix}.herdr` : "herdr", policy);
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
    ...(step.when !== undefined ? { when: parseWhen(file, stepIndex, step.when) } : {}),
    ...(step.continue_on_error === true ? { continueOnError: true } : {}),
    action: toAction(file, stepIndex, step),
  };
}

function toRecovery(file: string, step: z.infer<typeof recoveryStepSchema>): RecoveryAction {
  const asStep = toAction(file, undefined, step as RawStep, "on_failure");
  if (asStep.kind === "agent") {
    const { background: _b, ...rest } = asStep as AgentWithBackground;
    return rest;
  }
  if (asStep.kind === "run") {
    const { background: _b, retry: _r, ...rest } = asStep as RunWithExtras;
    return rest;
  }
  if (asStep.kind === "herdr") {
    const { retry: _r, ...rest } = asStep as HerdrWithRetry;
    return rest;
  }
  return asStep;
}

type AgentWithBackground = Extract<StepAction, { kind: "agent" }> & { background?: boolean };
type RunWithExtras = Extract<StepAction, { kind: "run" }> & {
  background?: boolean;
  retry?: RetrySpec;
};
type HerdrWithRetry = Extract<StepAction, { kind: "herdr" }> & { retry?: RetrySpec };

export function parseRaw(file: string, text: string): RawWorkflow {
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
    version: WORKFLOW_FORMAT,
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.hidden !== undefined ? { hidden: raw.hidden } : {}),
    ...(raw.inputs !== undefined ? { inputs: raw.inputs as Record<string, RawInputValue> } : {}),
    ...(raw.returns !== undefined ? { returns: parseReturns(file, raw.returns) } : {}),
    ...(raw.on_failure !== undefined ? { onFailure: toRecovery(file, raw.on_failure) } : {}),
    steps: raw.steps.map((step, i) => toStep(file, i + 1, step)),
  };
}

function collectTemplatesFromValue(value: unknown, out: TemplatePath[]): void {
  if (typeof value === "string") {
    out.push(...textTemplates(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplatesFromValue(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectTemplatesFromValue(item, out);
  }
}

function stepTemplates(step: WorkflowStep): TemplatePath[] {
  const out: TemplatePath[] = [];
  if (step.when?.kind === "truthy") {
    const p = parseTemplatePath(step.when.path);
    if (p) out.push(p);
  }
  if (step.when?.kind === "eq") {
    const p = parseTemplatePath(step.when.path);
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
