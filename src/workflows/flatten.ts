import { resolveWorkflowFile } from "./discover";
import { WorkflowLoadError, positioned, type FlatStep } from "./errors";
import { parseRaw, type RawWorkflow } from "./parse";
import { rawToFlat } from "./steps";

export async function parseFile(file: string): Promise<{ file: string; raw: RawWorkflow }> {
  if (!(await Bun.file(file).exists())) {
    throw new WorkflowLoadError(positioned(file, undefined, undefined, "file not found"));
  }
  return { file, raw: parseRaw(file, await Bun.file(file).text()) };
}

export async function flattenSteps(
  name: string,
  repoRoot: string,
  stack: string[],
  sources?: Set<"repo" | "global">,
  root?: { file: string; source: "repo" | "global" },
  rootRaw?: RawWorkflow,
): Promise<FlatStep[]> {
  if (stack.includes(name)) {
    throw new WorkflowLoadError(
      positioned(
        `${name}.yaml`,
        undefined,
        "run",
        `cycle detected: ${[...stack, name].join(" → ")}`,
      ),
    );
  }
  const resolved = stack.length === 0 && root ? root : await resolveWorkflowFile(name, repoRoot);
  if (!resolved) {
    const from = stack[stack.length - 1];
    throw new WorkflowLoadError(
      positioned(
        from ? `${from}.yaml` : `${name}.yaml`,
        undefined,
        "run",
        `unknown workflow '${name}'`,
      ),
    );
  }
  sources?.add(resolved.source);
  const parsed =
    stack.length === 0 && rootRaw
      ? { file: resolved.file, raw: rootRaw }
      : await parseFile(resolved.file);
  if (stack.length > 0 && parsed.raw.inputs !== undefined) {
    throw new WorkflowLoadError(
      positioned(
        `${stack[stack.length - 1]}.yaml`,
        undefined,
        "run",
        `spliced workflow '${name}' declares inputs — declare them on the entry workflow`,
      ),
    );
  }
  const next = [...stack, name];
  const out: FlatStep[] = [];
  for (const [i, step] of parsed.raw.steps.entries()) {
    if (step.run !== undefined)
      out.push(...(await flattenSteps(step.run, repoRoot, next, sources)));
    else out.push(rawToFlat(resolved.file, i + 1, step));
  }
  return out;
}
