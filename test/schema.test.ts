import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema";

const committed = join(import.meta.dir, "..", "docs", "workflow.schema.json");

describe("workflow JSON schema", () => {
  test("docs/workflow.schema.json matches buildSchema()", async () => {
    const expected = buildSchema();
    const file = Bun.file(committed);
    expect(await file.exists()).toBe(true);
    const actual = await file.json();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("docs/workflow.schema.json is stale — run `bun run schema`");
    }
  });
});
