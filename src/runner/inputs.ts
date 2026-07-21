import type { InputSpec } from "../workflows";

export type ResolvedInputs =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/** Merge provided values with declared defaults; reject unknown, missing, and out-of-set values. */
export function resolveInputValues(
  specs: InputSpec[],
  provided: Record<string, string> = {},
): ResolvedInputs {
  const declared = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) return { ok: false, error: `unknown input '${name}'` };
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const spec of specs) {
    const value = Object.hasOwn(provided, spec.name) ? provided[spec.name] : spec.default;
    if (value === undefined) {
      return { ok: false, error: `missing input '${spec.name}' (--input ${spec.name}=…)` };
    }
    if (spec.options && !spec.options.includes(value)) {
      return {
        ok: false,
        error: `input '${spec.name}' must be one of: ${spec.options.join(", ")}`,
      };
    }
    values[spec.name] = value;
  }
  return { ok: true, values };
}
