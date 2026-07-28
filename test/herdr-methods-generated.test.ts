import { describe, test } from "bun:test";
import { join } from "node:path";
import { buildGeneratedSource } from "../scripts/generate-herdr-methods";

const committed = join(import.meta.dir, "..", "src", "herdr-methods.generated.ts");

describe("herdr methods generated module", () => {
  test("src/herdr-methods.generated.ts matches buildGeneratedSource()", async () => {
    const { source: expected } = await buildGeneratedSource();
    if ((await Bun.file(committed).text()) !== expected) {
      throw new Error("src/herdr-methods.generated.ts is stale — run `bun run schema:herdr`");
    }
  });
});
