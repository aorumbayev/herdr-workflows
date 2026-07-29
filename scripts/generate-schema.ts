import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { rawWorkflowSchema } from "../src/workflow/parse";

const OUT = join(import.meta.dir, "..", "docs", "workflow.schema.json");

export function buildSchema(): unknown {
  const schema = z.toJSONSchema(rawWorkflowSchema) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json",
    title: "herdr-workflows workflow",
    description:
      "Linear YAML workflow for the herdr-workflows herdr plugin (format v1alpha1). Cross-field rules are enforced by the parser and loader, not this schema.",
  };
}

if (import.meta.main) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  const fmt = spawnSync("bunx", ["oxfmt", OUT], { stdio: "inherit" });
  if ((fmt.status ?? 1) !== 0) process.exit(fmt.status ?? 1);
}
