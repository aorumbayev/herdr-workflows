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
      "Linear YAML workflow for the herdr-workflows herdr plugin (syntax v2). Cross-field rules (one action key per step; placeholder legality by run: form; when/for/retry; primitives) are enforced by the loader, not this schema.",
  };
}

if (import.meta.main) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(buildSchema(), null, 2)}\n`);
}
