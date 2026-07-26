import { WorkflowLoadError, positioned } from "./types";
import { parseRaw, type RawWorkflow } from "./parse";

export async function parseFile(file: string): Promise<{ file: string; raw: RawWorkflow }> {
  if (!(await Bun.file(file).exists())) {
    throw new WorkflowLoadError(positioned(file, undefined, undefined, "file not found"));
  }
  return { file, raw: parseRaw(file, await Bun.file(file).text()) };
}
