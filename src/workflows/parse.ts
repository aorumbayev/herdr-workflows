import { z } from "zod";
import { WorkflowLoadError, positioned } from "./errors";
import { refineStepVerbs } from "./refine";

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
  })
  .strict()
  .superRefine(refineStepVerbs);

export const rawWorkflowSchema = z
  .object({
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
