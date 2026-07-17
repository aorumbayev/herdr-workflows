import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { rawWorkflowSchema } from "../src/workflows/parse";

const OUT = join(import.meta.dir, "..", "docs", "workflow.schema.json");

export function buildSchema(): unknown {
  const schema = z.toJSONSchema(rawWorkflowSchema) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json",
    title: "herdr-workflows workflow",
    description:
      "Linear YAML workflow for the herdr-workflows herdr plugin. Cross-field rules (one verb per step; wait only on agent; wait_for only on open; timeout requires wait/wait_for; {session} only in stdin) are enforced by the loader, not this schema.",
  };
}

if (import.meta.main) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(buildSchema(), null, 2)}\n`);
}
