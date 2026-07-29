import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema";

const committed = join(import.meta.dir, "..", "docs", "workflow.schema.json");

/** A blank or non-string description renders as nothing on hover, so it does not count. */
function documented(node: unknown): boolean {
  const description = (node as { description?: unknown } | null)?.description;
  return typeof description === "string" && description.trim() !== "";
}

/**
 * Every authored surface of the schema, as a dotted path, paired with whether it documents itself.
 * Properties are one such surface; so is each member of a union, because a reader hovering an
 * `inputs:` shorthand sees the member's own description and nothing else.
 */
function describedSurfaces(node: unknown, path = ""): { path: string; described: boolean }[] {
  if (node === null || typeof node !== "object") return [];
  const found: { path: string; described: boolean }[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
        found.push({ path: `${path}.${name}`, described: documented(prop) });
      }
    }
    // Members carry their own text only when nothing encloses them that could: a union under a
    // described property is already explained by that property, but the value union of a record
    // (`inputs:`) has no property of its own, so the members are all a reader gets.
    if (
      (key === "anyOf" || key === "oneOf") &&
      Array.isArray(value) &&
      value.length > 1 &&
      !documented(node)
    ) {
      value.forEach((member, i) =>
        found.push({ path: `${path}.${key}[${i}]`, described: documented(member) }),
      );
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => found.push(...describedSurfaces(entry, `${path}.${key}[${i}]`)));
    } else {
      found.push(...describedSurfaces(value, `${path}.${key}`));
    }
  }
  return found;
}

describe("workflow JSON schema", () => {
  test("docs/workflow.schema.json matches buildSchema()", async () => {
    const expected = buildSchema();
    const actual = await Bun.file(committed).json();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("docs/workflow.schema.json is stale — run `bun run schema`");
    }
  });

  // The editor renders `description` on hover and the workbench form serves the same schema, so an
  // undocumented surface is invisible in both. Add `.describe()` to the Zod field, not to the JSON.
  test("every property and union member documents itself", () => {
    const surfaces = describedSurfaces(buildSchema());
    expect(surfaces.filter((s) => !s.described).map((s) => s.path)).toEqual([]);
    // Guards the walker itself: a refactor that stops finding surfaces would otherwise pass empty.
    expect(surfaces.length).toBeGreaterThan(70);
  });
});
