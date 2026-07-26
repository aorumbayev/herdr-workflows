import { resolveWorkflowFile } from "./discover";
import { WorkflowLoadError, positioned, type FlatStep } from "./errors";
import { flattenSteps, parseFile } from "./flatten";
import { checkAgents } from "./steps";

export async function loadRecovery(
  entryFile: string,
  onFail: string,
  repoRoot: string,
  agents: Set<string>,
  sources?: Set<"repo" | "global">,
): Promise<FlatStep[]> {
  const resolved = await resolveWorkflowFile(onFail, repoRoot);
  if (!resolved) {
    throw new WorkflowLoadError(
      positioned(entryFile, undefined, "on_fail", `unknown workflow '${onFail}'`),
    );
  }
  const parsed = await parseFile(resolved.file);
  sources?.add(resolved.source);
  if (parsed.raw.on_fail !== undefined) {
    throw new WorkflowLoadError(
      positioned(entryFile, undefined, "on_fail", `recovery target '${onFail}' declares on_fail`),
    );
  }
  if (parsed.raw.inputs !== undefined) {
    throw new WorkflowLoadError(
      positioned(
        entryFile,
        undefined,
        "on_fail",
        `recovery target '${onFail}' declares inputs — declare them on the entry workflow`,
      ),
    );
  }
  const steps = await flattenSteps(onFail, repoRoot, [], sources, resolved, parsed.raw);
  checkAgents(entryFile, steps, agents);
  return steps;
}
