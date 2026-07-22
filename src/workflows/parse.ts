import { z } from "zod";
import { WorkflowLoadError, positioned } from "./errors";
import { refineStepVerbs } from "./refine";
import { INPUT_NAME_RE } from "./substitute";

const rawStepSchema = z
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
  .superRefine(refineStepVerbs);

const rawInputSchema = z
  .object({
    label: z.string().min(1).optional(),
    options: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    default: z.string().optional(),
  })
  .strict();

export const rawWorkflowSchema = z
  .object({
    inputs: z
      .record(
        z.string().regex(INPUT_NAME_RE, "input name must match [a-z][a-z0-9_]{0,31}"),
        rawInputSchema,
      )
      .optional(),
    steps: z.array(rawStepSchema).min(1),
    on_fail: z.string().min(1).optional(),
  })
  .strict();

export type RawStep = z.infer<typeof rawStepSchema>;
export type RawWorkflow = z.infer<typeof rawWorkflowSchema>;

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
  return positioned(file, step, key, issue.message);
}

export function parseRaw(file: string, text: string): RawWorkflow {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (error) {
    throw new WorkflowLoadError(
      positioned(
        file,
        undefined,
        undefined,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const result = rawWorkflowSchema.safeParse(data);
  if (!result.success) {
    throw new WorkflowLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  return result.data;
}
