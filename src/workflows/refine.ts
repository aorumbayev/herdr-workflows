import type { z } from "zod";

const VERBS = ["shell", "open", "agent", "herdr", "run"] as const;

type StepShape = {
  shell?: string;
  open?: string;
  agent?: string;
  herdr?: string;
  run?: string;
  stdin?: string;
  prompt?: string;
  params?: Record<string, unknown>;
  wait?: "done";
  wait_for?: string;
  timeout?: number;
  close_source?: boolean;
};

export function refineStepVerbs(step: StepShape, ctx: z.core.$RefinementCtx): void {
  const verbs = VERBS.filter((v) => step[v] !== undefined);
  if (verbs.length === 0) {
    ctx.addIssue({ code: "custom", message: "step has no verb" });
    return;
  }
  if (verbs.length > 1) {
    ctx.addIssue({ code: "custom", message: `step has multiple verbs: ${verbs.join(", ")}` });
    return;
  }
  const verb = verbs[0]!;
  if (step.stdin !== undefined && verb !== "shell") {
    ctx.addIssue({ code: "custom", message: "stdin only allowed on shell", path: ["stdin"] });
  }
  if (step.prompt !== undefined && verb !== "agent") {
    ctx.addIssue({ code: "custom", message: "prompt only allowed on agent", path: ["prompt"] });
  }
  if (step.params !== undefined && verb !== "herdr") {
    ctx.addIssue({ code: "custom", message: "params only allowed on herdr", path: ["params"] });
  }
  if (step.wait !== undefined && verb !== "agent") {
    ctx.addIssue({ code: "custom", message: "wait only allowed on agent", path: ["wait"] });
  }
  if (step.wait_for !== undefined && verb !== "open") {
    ctx.addIssue({ code: "custom", message: "wait_for only allowed on open", path: ["wait_for"] });
  }
  if (step.close_source !== undefined && verb !== "agent") {
    ctx.addIssue({
      code: "custom",
      message: "close_source only allowed on agent",
      path: ["close_source"],
    });
  }
  if (step.timeout !== undefined && step.wait === undefined && step.wait_for === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "timeout requires wait or wait_for",
      path: ["timeout"],
    });
  }
  if (
    verb === "run" &&
    (step.stdin !== undefined ||
      step.prompt !== undefined ||
      step.params !== undefined ||
      step.wait !== undefined ||
      step.wait_for !== undefined ||
      step.timeout !== undefined ||
      step.close_source !== undefined)
  ) {
    ctx.addIssue({ code: "custom", message: "run steps take no modifiers", path: ["run"] });
  }
}
