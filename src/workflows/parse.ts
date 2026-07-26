import { z } from "zod";
import { bail, positioned, WorkflowLoadError } from "./types";
import { INPUT_NAME_RE } from "./substitute";
import { rawStepSchema, type RawStep } from "./step-schema";

const V1_TOP_KEYS: Record<string, string> = {
  on_fail: "on_error",
};

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
  .strict()
  .superRefine((doc, ctx) => {
    // zod strict already rejects unknown keys; map on_fail via preprocess before this
    if (doc.on_error === undefined && "on_fail" in (doc as object)) {
      ctx.addIssue({
        code: "custom",
        message: `'on_fail' is removed — use on_error`,
        path: ["on_fail"],
      });
    }
  });

export type RawWorkflow = {
  desc?: string;
  inputs?: Record<string, z.infer<typeof rawInputValueSchema>>;
  on_error?: string | RawStep[];
  steps: RawStep[];
};

export type { RawStep };

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
    const hints = keys.map((k) =>
      k in V1_TOP_KEYS ? `'${k}' is removed — use ${V1_TOP_KEYS[k]}` : `unknown key '${k}'`,
    );
    message = hints.join("; ");
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
  if (data && typeof data === "object" && !Array.isArray(data) && "on_fail" in data) {
    bail(file, undefined, "on_fail", `'on_fail' is removed — use on_error`);
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
