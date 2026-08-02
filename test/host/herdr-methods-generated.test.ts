import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildGeneratedSource, focusPolicyForMethod } from "../../scripts/generate-herdr-methods";

const committed = join(import.meta.dir, "..", "..", "src", "herdr-methods.generated.ts");

describe("herdr methods generated module", () => {
  test("src/herdr-methods.generated.ts matches buildGeneratedSource()", async () => {
    const { source: expected } = await buildGeneratedSource();
    if ((await Bun.file(committed).text()) !== expected) {
      throw new Error("src/herdr-methods.generated.ts is stale — run `bun run schema:herdr`");
    }
  });

  test("regenerated method with unclassified optional selectors fails generation", () => {
    expect(() =>
      focusPolicyForMethod({
        method: "pane.rotate",
        params: {
          required: [],
          properties: {
            pane_id: { kinds: ["string"], nullable: true },
            tab_id: { kinds: ["string"], nullable: true },
          },
          additionalProperties: false,
        },
      }),
    ).toThrow(/classify/);
  });
});
