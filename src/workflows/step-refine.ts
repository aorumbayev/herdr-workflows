import type { z } from "zod";
import { COMPOSITE_KEYS, PLACEMENTS, SHELLS, V1_STEP_REASONS } from "./step-keys";

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

function refineV1Removals(step: Record<string, unknown>, ctx: RefineCtx): void {
  for (const key of Object.keys(step)) {
    if (key in V1_STEP_REASONS) {
      ctx.addIssue({
        code: "custom",
        message: `'${key}:' is removed — use ${V1_STEP_REASONS[key]}`,
        path: [key],
      });
    }
  }
  if (step.wait === "done") {
    ctx.addIssue({
      code: "custom",
      message: `'wait: done' is removed — blocking is the default; omit wait: or use wait: false / wait: /regex/`,
      path: ["wait"],
    });
  }
}

function resolveActionKey(step: Record<string, unknown>, ctx: RefineCtx): string | undefined {
  const actionKeys = Object.keys(step).filter(isActionKey);
  if (actionKeys.length === 0) {
    if (step.shell !== undefined && step.run === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `'shell:' as a step verb is removed — use run:`,
        path: ["shell"],
      });
      return undefined;
    }
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
    if (key in V1_STEP_REASONS) continue;
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

export function refineRawStep(
  step: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  refineV1Removals(step, ctx);
  const action = resolveActionKey(step, ctx);
  if (action === undefined) return;
  refineUnknownKeys(step, action, ctx);
  refineActionModifiers(step, action, ctx);
  refineWaitOut(step, action, ctx);
}
