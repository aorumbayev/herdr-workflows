import { resolveWorkflowFile, workflowPath } from "./load";
import { parseRaw } from "./parse";
import { encodePayload, formatImportCommand, type WorkflowBundleEntry } from "./payload";
import { referencedWorkflowChildren } from "./trust";
import { WorkflowLoadError } from "./types";

export type ExportedBundle = {
  entries: WorkflowBundleEntry[];
  provenance: { name: string; source: "repo" | "global" }[];
  payload: string;
  command: string;
};

/**
 * Exact selected source plus transitively referenced workflows (repo-first for children).
 * Provenance is for local display only — never encoded in the payload.
 */
export async function exportWorkflowBundle(opts: {
  name: string;
  scope: "repo" | "global";
  repoRoot: string;
}): Promise<ExportedBundle> {
  const entries: WorkflowBundleEntry[] = [];
  const provenance: { name: string; source: "repo" | "global" }[] = [];
  const seen = new Set<string>();

  const visit = async (
    name: string,
    exactScope: "repo" | "global" | undefined,
    stack: string[],
  ): Promise<void> => {
    if (stack.includes(name)) {
      throw new WorkflowLoadError(`workflow cycle: ${[...stack, name].join(" → ")}`);
    }
    if (seen.has(name)) return;

    let file: string;
    let source: "repo" | "global";
    if (exactScope) {
      file = workflowPath(exactScope, opts.repoRoot, name);
      source = exactScope;
      if (!(await Bun.file(file).exists())) {
        throw new WorkflowLoadError(`workflow '${name}' not found in ${exactScope}`);
      }
    } else {
      const resolved = await resolveWorkflowFile(name, opts.repoRoot);
      if (!resolved) {
        throw new WorkflowLoadError(
          `workflow '${name}' not found (via ${stack.join(" → ") || "entry"})`,
        );
      }
      file = resolved.file;
      source = resolved.source;
    }

    const yaml = await Bun.file(file).text();
    const raw = parseRaw(file, yaml);
    seen.add(name);
    entries.push({ name, yaml });
    provenance.push({ name, source });

    const nextStack = [...stack, name];
    for (const child of referencedWorkflowChildren(raw)) {
      await visit(child, undefined, nextStack);
    }
  };

  await visit(opts.name, opts.scope, []);
  const payload = encodePayload(entries);
  return {
    entries,
    provenance,
    payload,
    command: formatImportCommand(payload),
  };
}
