import { z } from "zod";
import { isResultDotPath, validateMethodParams } from "../herdr-methods";
import {
  bail,
  BUILTIN_NAMES,
  positioned,
  WorkflowLoadError,
  type FlatStep,
  type ForSource,
  type Guard,
  type OutSpec,
  type Placement,
  type PlaceholderValues,
  type RetrySpec,
  type RunPayload,
  type ShellName,
  type WaitSpec,
} from "./types";

const COMPOSITE_KEYS = ["run", "agent", "use"] as const;
const PLACEMENTS = ["here", "tab", "right", "down"] as const;
const SHELLS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"] as const;

const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const IDENT_PLACEHOLDER_RE = /\{([a-z][a-z0-9_]{0,31})\}/g;

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

function firstPlaceholder(text: string): string | undefined {
  IDENT_PLACEHOLDER_RE.lastIndex = 0;
  const m = IDENT_PLACEHOLDER_RE.exec(text);
  return m?.[1];
}

function textHasPrompt(text: string): boolean {
  return textPlaceholders(text).includes("prompt");
}

function textHasSession(text: string): boolean {
  const names = textPlaceholders(text);
  return names.includes("session") || names.includes("session_file");
}

function paramsPlaceholders(params: Record<string, unknown> | undefined): string[] {
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

function paramsHavePrompt(params: Record<string, unknown> | undefined): boolean {
  return paramsAnyText(params, textHasPrompt);
}

function paramsHaveSession(params: Record<string, unknown> | undefined): boolean {
  return paramsAnyText(params, textHasSession);
}

function isMethodKey(key: string): boolean {
  return key.includes(".") && !key.includes(" ");
}

function isActionKey(key: string): boolean {
  return (COMPOSITE_KEYS as readonly string[]).includes(key) || isMethodKey(key);
}

const MODIFIER_KEYS = [
  "name",
  "in",
  "ratio",
  "cwd",
  "shell",
  "env",
  "out",
  "with",
  "when",
  "for",
  "as",
  "retry",
  "wait",
  "timeout",
  "allow_fail",
  "on_error",
  "prompt",
] as const;

type RefineCtx = z.core.$RefinementCtx<Record<string, unknown>>;

function resolveActionKey(step: Record<string, unknown>, ctx: RefineCtx): string | undefined {
  const actionKeys = Object.keys(step).filter(isActionKey);
  if (actionKeys.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: `step has no action key (expected run, agent, use, or a dotted method)`,
    });
    return undefined;
  }
  if (actionKeys.length > 1) {
    ctx.addIssue({
      code: "custom",
      message: `step has multiple action keys: ${actionKeys.join(", ")}`,
    });
    return undefined;
  }
  return actionKeys[0]!;
}

function refineUnknownKeys(step: Record<string, unknown>, action: string, ctx: RefineCtx): void {
  for (const key of Object.keys(step)) {
    if (key === action) continue;
    if ((MODIFIER_KEYS as readonly string[]).includes(key)) continue;
    ctx.addIssue({ code: "custom", message: `unknown step key '${key}'`, path: [key] });
  }
}

function refineShell(step: Record<string, unknown>, action: string, ctx: RefineCtx): void {
  if (step.shell !== undefined && action !== "run") {
    ctx.addIssue({
      code: "custom",
      message: "shell: is only allowed on run: steps",
      path: ["shell"],
    });
  }
  if (step.shell !== undefined && Array.isArray(step.run)) {
    ctx.addIssue({
      code: "custom",
      message: "argv form does not use a shell",
      path: ["shell"],
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

function refineActionModifiers(
  step: Record<string, unknown>,
  action: string,
  ctx: RefineCtx,
): void {
  refineShell(step, action, ctx);
  if (step.prompt !== undefined && action !== "agent") {
    ctx.addIssue({
      code: "custom",
      message: "prompt: is only allowed on agent:",
      path: ["prompt"],
    });
  }
  if (step.with !== undefined && action !== "use") {
    ctx.addIssue({
      code: "custom",
      message: "with: is only allowed on use:",
      path: ["with"],
    });
  }
  if (step.in !== undefined && action !== "run" && action !== "agent") {
    ctx.addIssue({
      code: "custom",
      message: "in: is only allowed on run: and agent:",
      path: ["in"],
    });
  }
  if (step.cwd !== undefined && action !== "run" && action !== "agent") {
    ctx.addIssue({
      code: "custom",
      message: "cwd: is only allowed on run: and agent:",
      path: ["cwd"],
    });
  }
  if (step.env !== undefined && action !== "run" && action !== "agent") {
    ctx.addIssue({
      code: "custom",
      message: "env: is only allowed on run: and agent:",
      path: ["env"],
    });
  }
  if (step.ratio !== undefined) {
    const place = step.in ?? (action === "agent" ? "tab" : action === "run" ? "here" : undefined);
    if (place !== "right" && place !== "down") {
      ctx.addIssue({
        code: "custom",
        message: "ratio: requires in: right or in: down",
        path: ["ratio"],
      });
    }
  }
  if (typeof step.in === "string" && !(PLACEMENTS as readonly string[]).includes(step.in)) {
    ctx.addIssue({
      code: "custom",
      message: `in: must be one of ${PLACEMENTS.join(", ")}`,
      path: ["in"],
    });
  }
}

function refineWaitOut(step: Record<string, unknown>, action: string, ctx: RefineCtx): void {
  const waitRegex =
    typeof step.wait === "string" &&
    step.wait.length >= 2 &&
    step.wait.startsWith("/") &&
    step.wait.endsWith("/");
  if (waitRegex) {
    const place = step.in ?? (action === "agent" ? "tab" : action === "run" ? "here" : "here");
    if (place === "here") {
      ctx.addIssue({
        code: "custom",
        message: "wait: /regex/ requires a placed step (in: tab, right, or down)",
        path: ["wait"],
      });
    }
  }
  if (step.wait === false && step.out !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "a detached step produces nothing to capture — remove out: or wait:",
      path: ["out"],
    });
  }
}

function refineRawStep(
  step: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const action = resolveActionKey(step, ctx);
  if (action === undefined) return;
  refineUnknownKeys(step, action, ctx);
  refineActionModifiers(step, action, ctx);
  refineWaitOut(step, action, ctx);
}

const rawStepSchema = z.record(z.string(), z.unknown()).superRefine(refineRawStep);

export type RawStep = z.infer<typeof rawStepSchema>;

const rawInputMapSchema = z
  .object({
    type: z.enum(["text", "agents"]).optional(),
    label: z.string().min(1).optional(),
    desc: z.string().optional(),
    options: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    default: z.string().optional(),
  })
  .strict();

const rawInputValueSchema = z.union([
  z.string(),
  z.array(z.string().min(1)).min(1),
  rawInputMapSchema,
]);

const onErrorSchema = z.union([z.string().min(1), z.array(rawStepSchema).min(1)]);

export const rawWorkflowSchema = z
  .object({
    desc: z.string().optional(),
    inputs: z
      .record(
        z.string().regex(INPUT_NAME_RE, "input name must match [a-z][a-z0-9_]{0,31}"),
        rawInputValueSchema,
      )
      .optional(),
    on_error: onErrorSchema.optional(),
    steps: z.union([z.string().min(1), rawStepSchema, z.array(rawStepSchema).min(1)]),
  })
  .strict();

export type RawWorkflow = {
  desc?: string;
  inputs?: Record<string, z.infer<typeof rawInputValueSchema>>;
  on_error?: string | RawStep[];
  steps: RawStep[];
};

/** Rewrite `name: [a, b] = def` (invalid YAML) into a map form before parse. */
function preprocessWorkflowYaml(text: string): string {
  return text.replace(
    /^([ \t]*)([a-z][a-z0-9_]*):[ \t]*(\[[^\]]*\])[ \t]*=[ \t]*(.+)$/gm,
    (_m, indent: string, key: string, list: string, def: string) =>
      `${indent}${key}:\n${indent}  options: ${list}\n${indent}  default: ${def.trim()}`,
  );
}

function formatIssue(file: string, issue: z.core.$ZodIssue): string {
  const path = issue.path;
  let step: number | undefined;
  let key: string | undefined;
  if (path[0] === "steps" && typeof path[1] === "number") {
    step = path[1] + 1;
    if (path.length >= 3) key = String(path[2]);
  } else if (path.length > 0) {
    key = String(path[0]);
  } else if (issue.code === "unrecognized_keys") {
    key = (issue as { keys: string[] }).keys.join(", ");
  }
  let message = issue.message;
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as { keys: string[] }).keys;
    message = keys.map((k) => `unknown key '${k}'`).join("; ");
    key = keys[0];
  }
  return positioned(file, step, key, message);
}

export function normalizeSteps(steps: z.infer<typeof rawWorkflowSchema>["steps"]): RawStep[] {
  if (typeof steps === "string") return [{ run: steps }];
  if (Array.isArray(steps)) return steps;
  return [steps];
}

export function parseRaw(file: string, text: string): RawWorkflow {
  let data: unknown;
  try {
    data = Bun.YAML.parse(preprocessWorkflowYaml(text));
  } catch (error) {
    bail(file, undefined, undefined, error instanceof Error ? error.message : String(error));
  }
  if (data && typeof data === "object" && !Array.isArray(data) && !("steps" in data)) {
    bail(file, undefined, "steps", "steps is required");
  }
  const result = rawWorkflowSchema.safeParse(data);
  if (!result.success) {
    throw new WorkflowLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  return {
    desc: result.data.desc,
    inputs: result.data.inputs,
    on_error: result.data.on_error,
    steps: normalizeSteps(result.data.steps),
  };
}

const PLACEHOLDER_SHELL =
  'placeholders are not allowed in shell command text — use argv form (run: [cmd, "{name}"]) or HWF_<name> env vars';

const NONEMPTY_GUARD_RE = /^(!?)\{([a-z][a-z0-9_]{0,31})\}$/;
const FOR_BINDING_RE = /^\{([a-z][a-z0-9_]{0,31})\}$/;
const FOR_SH_RE = /^sh\s+(.+)$/s;

function rejectShellPlaceholders(
  file: string,
  stepIndex: number,
  key: string | undefined,
  text: string,
): void {
  if (firstPlaceholder(text)) {
    bail(file, stepIndex, key, PLACEHOLDER_SHELL);
  }
}

function parseGuard(file: string, stepIndex: number, key: string, value: unknown): Guard {
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, key, "argv guard elements must be strings");
    }
    return { kind: "argv", argv: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, key, "when:/until: must be a string or argv list");
  }
  const m = NONEMPTY_GUARD_RE.exec(value);
  if (m) return { kind: "nonempty", name: m[2]!, negate: m[1] === "!" };
  rejectShellPlaceholders(file, stepIndex, key, value);
  return { kind: "shell", command: value };
}

function parseFor(file: string, stepIndex: number, value: unknown): ForSource {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      bail(file, stepIndex, "for", "for: list is empty");
    }
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, "for", "for: list elements must be strings");
    }
    return { kind: "list", items: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, "for", "for: must be a list, sh <cmd>, or {name}");
  }
  const bind = FOR_BINDING_RE.exec(value);
  if (bind) return { kind: "binding", name: bind[1]! };
  const sh = FOR_SH_RE.exec(value);
  if (sh) {
    rejectShellPlaceholders(file, stepIndex, "for", sh[1]!);
    return { kind: "sh", command: sh[1]! };
  }
  bail(file, stepIndex, "for", "for: must be a list, sh <cmd>, or {name}");
}

function parseRetry(file: string, stepIndex: number, value: unknown): RetrySpec {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      bail(file, stepIndex, "retry", "times must be at least 1");
    }
    return { times: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bail(file, stepIndex, "retry", "retry: must be an integer or map");
  }
  const map = value as Record<string, unknown>;
  const times = map.times;
  if (typeof times !== "number" || !Number.isInteger(times) || times < 1) {
    bail(file, stepIndex, "retry", "times must be at least 1");
  }
  const spec: RetrySpec = { times };
  if (map.delay !== undefined) {
    if (typeof map.delay !== "number" || map.delay < 0) {
      bail(file, stepIndex, "retry", "delay must be a non-negative number");
    }
    spec.delaySec = map.delay;
  }
  if (map.until !== undefined) spec.until = parseGuard(file, stepIndex, "until", map.until);
  if (map.reset !== undefined) {
    if (typeof map.reset !== "string") {
      bail(file, stepIndex, "retry", "reset: must be a shell command string");
    }
    rejectShellPlaceholders(file, stepIndex, "reset", map.reset);
    spec.reset = map.reset;
  }
  return spec;
}

function parseWait(file: string, stepIndex: number, value: unknown): WaitSpec {
  if (value === undefined || value === true) return { kind: "block" };
  if (value === false) return { kind: "detach" };
  if (
    typeof value === "string" &&
    value.length >= 2 &&
    value.startsWith("/") &&
    value.endsWith("/")
  ) {
    return { kind: "regex", pattern: value.slice(1, -1) };
  }
  bail(file, stepIndex, "wait", "wait: must be true, false, or /regex/");
}

function parseOut(file: string, stepIndex: number, value: unknown): OutSpec {
  if (typeof value === "string") {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(value)) {
      bail(file, stepIndex, "out", "out: name must match [a-z][a-z0-9_]{0,31}");
    }
    return { kind: "text", name: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const fields: Record<string, string> = {};
    for (const [name, path] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
        bail(file, stepIndex, "out", `out: name '${name}' must match [a-z][a-z0-9_]{0,31}`);
      }
      if (typeof path !== "string" || !path) {
        bail(file, stepIndex, "out", `out.${name} must be a dot-path string`);
      }
      if (!isResultDotPath(path)) {
        bail(file, stepIndex, "out", `out.${name}: unresolvable result path '${path}'`);
      }
      fields[name] = path;
    }
    return { kind: "map", fields };
  }
  bail(file, stepIndex, "out", "out: must be an identifier or map");
}

function parseRunPayload(file: string, stepIndex: number, step: RawStep): RunPayload {
  const value = step.run;
  const shell = (typeof step.shell === "string" ? step.shell : "sh") as ShellName;
  if (!(SHELLS as readonly string[]).includes(shell)) {
    bail(file, stepIndex, "shell", `shell: must be one of ${SHELLS.join(", ")}`);
  }
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, "run", "argv elements must be strings");
    }
    return { form: "argv", argv: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, "run", "run: must be a string or argv list");
  }
  rejectShellPlaceholders(file, stepIndex, "run", value);
  return { form: value.includes("\n") ? "block" : "scalar", command: value, shell };
}

export function stepReferencedNames(step: FlatStep): string[] {
  const names: string[] = [];
  const addText = (text: string | undefined) => {
    if (text) names.push(...textPlaceholders(text));
  };
  const a = step.action;
  if (a.kind === "run") {
    if (a.payload.form === "argv") for (const el of a.payload.argv) addText(el);
    if (a.cwd) addText(a.cwd);
    if (a.env) for (const v of Object.values(a.env)) addText(v);
  } else if (a.kind === "agent") {
    addText(a.agent);
    addText(a.prompt);
    if (a.cwd) addText(a.cwd);
    if (a.env) for (const v of Object.values(a.env)) addText(v);
  } else if (a.kind === "primitive") {
    names.push(...paramsPlaceholders(a.params));
  } else if (a.kind === "include") {
    for (const v of Object.values(a.with)) addText(v);
  }
  if (step.when?.kind === "nonempty") names.push(step.when.name);
  if (step.when?.kind === "argv") for (const el of step.when.argv) addText(el);
  if (step.for?.kind === "binding") names.push(step.for.name);
  if (step.retry?.until?.kind === "nonempty") names.push(step.retry.until.name);
  if (step.retry?.until?.kind === "argv") for (const el of step.retry.until.argv) addText(el);
  return names;
}

export function flatNeedsPrompt(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.prompt && textHasPrompt(s.action.prompt)) return true;
    if (s.action.kind === "primitive" && paramsHavePrompt(s.action.params)) return true;
    if (s.action.kind === "run" && s.action.payload.form === "argv") {
      return s.action.payload.argv.some(textHasPrompt);
    }
    if (s.action.kind === "include") return flatNeedsPrompt(s.action.steps);
    return stepReferencedNames(s).includes("prompt");
  });
}

export function flatNeedsSession(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.prompt && textHasSession(s.action.prompt))
      return true;
    if (s.action.kind === "primitive" && paramsHaveSession(s.action.params)) return true;
    if (s.action.kind === "run" && s.action.payload.form === "argv") {
      return s.action.payload.argv.some(textHasSession);
    }
    if (s.action.kind === "include") return flatNeedsSession(s.action.steps);
    return false;
  });
}

export function flatNeedsInvokingAgent(steps: FlatStep[]): boolean {
  return steps.some((s) => {
    if (s.action.kind === "agent" && s.action.agent === "{agent}") return true;
    if (s.action.kind === "include") return flatNeedsInvokingAgent(s.action.steps);
    return stepReferencedNames(s).includes("agent");
  });
}

export const AGENT_NAME_RE = /^\{([a-z][a-z0-9_]{0,31})\}$/;

function actionKeyOf(step: RawStep): string {
  const keys = Object.keys(step).filter(
    (k) => (COMPOSITE_KEYS as readonly string[]).includes(k) || isMethodKey(k),
  );
  return keys[0]!;
}

function placementOf(action: string, step: RawStep): Placement {
  if (typeof step.in === "string" && (PLACEMENTS as readonly string[]).includes(step.in)) {
    return step.in as Placement;
  }
  return action === "agent" ? "tab" : "here";
}

function outNames(out: OutSpec | undefined): string[] {
  if (!out) return [];
  if (out.kind === "text") return [out.name];
  return Object.keys(out.fields);
}

function envMap(step: RawStep): Record<string, string> | undefined {
  return step.env && typeof step.env === "object" && !Array.isArray(step.env)
    ? (step.env as Record<string, string>)
    : undefined;
}

function flatRun(file: string, stepIndex: number, step: RawStep, out: OutSpec | undefined) {
  const payload = parseRunPayload(file, stepIndex, step);
  const place = placementOf("run", step);
  if (out?.kind === "map" && place === "here") {
    bail(
      file,
      stepIndex,
      "out",
      "map out: requires a placed run: or a primitive with a structured result",
    );
  }
  if (out?.kind === "text" && place !== "here") {
    bail(
      file,
      stepIndex,
      "out",
      "identifier out: on a placed run: is invalid — use map form { tab: tab_id, … }",
    );
  }
  return {
    kind: "run" as const,
    payload,
    in: place,
    cwd: typeof step.cwd === "string" ? step.cwd : undefined,
    env: envMap(step),
    ratio: typeof step.ratio === "number" ? step.ratio : undefined,
  };
}

function flatAgent(file: string, stepIndex: number, step: RawStep, out: OutSpec | undefined) {
  if (typeof step.agent !== "string" || !step.agent) {
    bail(file, stepIndex, "agent", "agent: value is required");
  }
  if (out?.kind === "map") {
    bail(file, stepIndex, "out", "agent: produces text — use identifier out: form");
  }
  return {
    kind: "agent" as const,
    agent: step.agent,
    prompt: typeof step.prompt === "string" ? step.prompt : undefined,
    in: placementOf("agent", step),
    cwd: typeof step.cwd === "string" ? step.cwd : undefined,
    env: envMap(step),
    ratio: typeof step.ratio === "number" ? step.ratio : undefined,
  };
}

function flatPrimitive(
  file: string,
  stepIndex: number,
  method: string,
  step: RawStep,
  out: OutSpec | undefined,
) {
  const params =
    step[method] === null || step[method] === undefined
      ? undefined
      : typeof step[method] === "object" && !Array.isArray(step[method])
        ? (step[method] as Record<string, unknown>)
        : undefined;
  if (step[method] !== null && step[method] !== undefined && params === undefined) {
    bail(file, stepIndex, method, "primitive value must be a params object");
  }
  const err = validateMethodParams(method, params);
  if (err) bail(file, stepIndex, method, err);
  if (out?.kind === "text") {
    bail(file, stepIndex, "out", "primitive steps require map-form out: (name: dot.path)");
  }
  if (out?.kind === "map") {
    for (const [name, path] of Object.entries(out.fields)) {
      if (!isResultDotPath(path)) {
        bail(file, stepIndex, "out", `out.${name}: unresolvable result path '${path}'`);
      }
    }
  }
  return { kind: "primitive" as const, method, params };
}

export function rawToFlat(file: string, stepIndex: number, step: RawStep): FlatStep {
  const action = actionKeyOf(step);
  const wait = parseWait(file, stepIndex, step.wait);
  const out = step.out !== undefined ? parseOut(file, stepIndex, step.out) : undefined;
  const when = step.when !== undefined ? parseGuard(file, stepIndex, "when", step.when) : undefined;
  const forSource = step.for !== undefined ? parseFor(file, stepIndex, step.for) : undefined;
  if (step.as !== undefined) {
    if (!forSource) {
      bail(file, stepIndex, "as", "as: requires for:");
    }
    if (typeof step.as !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(step.as)) {
      bail(file, stepIndex, "as", "as: must match [a-z][a-z0-9_]{0,31}");
    }
  }
  const retry = step.retry !== undefined ? parseRetry(file, stepIndex, step.retry) : undefined;
  const timeoutMs = typeof step.timeout === "number" ? step.timeout * 1000 : undefined;

  let flatAction: FlatStep["action"];
  if (action === "run") flatAction = flatRun(file, stepIndex, step, out);
  else if (action === "agent") flatAction = flatAgent(file, stepIndex, step, out);
  else if (action === "use") {
    bail(file, stepIndex, "use", "internal: use: must be flattened before rawToFlat");
  } else flatAction = flatPrimitive(file, stepIndex, action, step, out);

  if (retry) {
    const createsPane =
      flatAction.kind === "agent" || (flatAction.kind === "run" && flatAction.in !== "here");
    if (createsPane && !retry.reset) {
      bail(
        file,
        stepIndex,
        "retry",
        "retry: on a pane-creating step requires reset: — herdr has no create-or-return-by-key method, so attempt 2 would strand attempt 1's pane; put the close in reset:",
      );
    }
  }

  return {
    name: typeof step.name === "string" ? step.name : undefined,
    action: flatAction,
    out,
    when,
    for: forSource,
    as: typeof step.as === "string" ? step.as : undefined,
    retry,
    wait,
    timeoutMs,
    allowFail: step.allow_fail === true ? true : undefined,
  };
}

export function stepOutNames(step: FlatStep): string[] {
  return outNames(step.out);
}

export function checkAgents(file: string, steps: FlatStep[], agents: Set<string>): void {
  const walk = (list: FlatStep[], baseIndex: number) => {
    list.forEach((step, idx) => {
      if (step.action.kind === "include") {
        walk(step.action.steps, baseIndex);
        return;
      }
      if (step.action.kind !== "agent") return;
      const name = step.action.agent;
      if (name === "{agent}") return;
      if (AGENT_NAME_RE.test(name)) return;
      if (!agents.has(name)) {
        bail(file, baseIndex + idx + 1, "agent", `unknown agent '${name}'`);
      }
    });
  };
  walk(steps, 0);
}
