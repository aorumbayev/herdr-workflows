import { z } from "zod";

const VERBS = ["shell", "open", "agent", "herdr", "run"] as const;

export const rawStepSchema = z
  .object({
    shell: z.string().optional(),
    open: z.string().optional(),
    agent: z.string().optional(),
    herdr: z.string().optional(),
    run: z.string().optional(),
    stdin: z.string().optional(),
    prompt: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    wait: z.literal("done").optional(),
    wait_for: z.string().min(1).optional(),
    timeout: z.number().int().positive().optional(),
    close_source: z.boolean().optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
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
      ctx.addIssue({
        code: "custom",
        message: "wait_for only allowed on open",
        path: ["wait_for"],
      });
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
  });
