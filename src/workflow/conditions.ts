import { renderScalar, substituteValue } from "./template";
import type { TemplateNamespace, WhenSpec } from "./types";

function clauseEqual(a: WhenSpec, b: WhenSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "truthy" && b.kind === "truthy") return a.path === b.path;
  if (a.kind === "eq" && b.kind === "eq") {
    return a.path === b.path && a.value === b.value && a.negate === b.negate;
  }
  return false;
}

/** True when every required clause appears among proven clauses (structural, no inference). */
export function clausesContain(proven: WhenSpec[], required: WhenSpec[]): boolean {
  return required.every((need) => proven.some((have) => clauseEqual(have, need)));
}

function isTruthyScalar(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (typeof value === "string") return value !== "";
  return true;
}

function evaluateWhenClause(when: WhenSpec, values: TemplateNamespace): boolean {
  const resolved = substituteValue(`{{${when.path}}}`, values);
  if (when.kind === "truthy") return isTruthyScalar(resolved);
  const left = renderScalar(resolved);
  return when.negate ? left !== when.value : left === when.value;
}

/** Ordered short-circuit AND over clauses. Empty/undefined is true. */
export function evaluateWhen(when: WhenSpec[] | undefined, values: TemplateNamespace): boolean {
  if (!when || when.length === 0) return true;
  for (const clause of when) {
    if (!evaluateWhenClause(clause, values)) return false;
  }
  return true;
}
