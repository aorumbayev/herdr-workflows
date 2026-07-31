import {
  HERDR_FOCUS_POLICY,
  HERDR_METHOD_BY_NAME,
  HERDR_PROTOCOL,
  METHOD_RESULT_VARIANTS,
  MIN_HERDR_VERSION,
  RESULT_DOT_PATHS,
  type PropSpec,
} from "./herdr-methods.generated";
import { WHOLE_TEMPLATE_RE } from "./workflow/types";

export { HERDR_PROTOCOL, METHOD_RESULT_VARIANTS, MIN_HERDR_VERSION, RESULT_DOT_PATHS };

type Params = Record<string, unknown>;

function present(params: Params, key: string): boolean {
  const value = params[key];
  return value !== undefined && value !== null && value !== "";
}

function explicit(method: string, detail: string): string {
  return `${method}: ${detail} — raw herdr calls never fall back to live herdr focus`;
}

function swapPolicy(method: string, params: Params): string | undefined {
  const direction = present(params, "direction") && present(params, "pane_id");
  const pair = present(params, "source_pane_id") && present(params, "target_pane_id");
  if (direction || pair) return undefined;
  return explicit(
    method,
    "needs direction with pane_id, or both source_pane_id and target_pane_id",
  );
}

function movePolicy(method: string, params: Params): string | undefined {
  const destination = params.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return `${method}: destination must be an object`;
  }
  const dest = destination as Params;
  if (dest.type === "tab" && !present(dest, "target_pane_id")) {
    return explicit(method, "destination type 'tab' needs destination.target_pane_id");
  }
  if (dest.type === "new_tab" && !present(dest, "workspace_id")) {
    return explicit(method, "destination type 'new_tab' needs destination.workspace_id");
  }
  return undefined;
}

/**
 * Explicit-target policy: omitted selectors must never reach live UI focus.
 * Classification comes from the generated schema; an unclassified method is rejected.
 */
export function assertFocusPolicy(method: string, params: Params | undefined): string | undefined {
  const obj = params ?? {};
  const policy = HERDR_FOCUS_POLICY.get(method);
  if (policy === undefined) {
    return explicit(method, "needs an explicit target selector (unclassified method)");
  }
  switch (policy.kind) {
    case "none":
    case "filter":
      return undefined;
    case "require":
      if (!present(obj, policy.field)) {
        return explicit(method, `params.${policy.field} is required`);
      }
      return undefined;
    case "exactlyOne": {
      const set = policy.fields.filter((key) => present(obj, key));
      if (set.length !== 1) {
        return explicit(method, `needs exactly one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    }
    case "atLeastOne":
      if (!policy.fields.some((key) => present(obj, key))) {
        return explicit(method, `needs one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    case "swap":
      return swapPolicy(method, obj);
    case "move":
      return movePolicy(method, obj);
  }
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(live: string, minimum: string): boolean {
  const a = parseSemver(live);
  const b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

type ParamKind = "string" | "number" | "integer" | "boolean" | "object" | "array";

function runtimeKind(value: unknown): ParamKind | "null" | "undefined" {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string" || t === "boolean" || t === "object") return t;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return "object";
}

function kindsMatch(spec: PropSpec, value: unknown): boolean {
  if (value === null) return spec.nullable;
  const kind = runtimeKind(value);
  if (kind === "null" || kind === "undefined") return false;
  if (spec.kinds.includes(kind)) return true;
  if (kind === "integer" && spec.kinds.includes("number")) return true;
  if (kind === "number" && spec.kinds.includes("integer") && Number.isInteger(value)) return true;
  return false;
}

function isWholeValueTemplateParam(value: unknown): boolean {
  return typeof value === "string" && WHOLE_TEMPLATE_RE.test(value);
}

/** Unknown / denied method, or params that violate the generated schema. */
export function validateMethodParams(
  method: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  const entry = HERDR_METHOD_BY_NAME.get(method);
  if (!entry) return `unknown herdr method '${method}'`;
  if (!entry.allowed) return `${method}: ${entry.reason}`;
  const obj = params ?? {};
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return `${method}: params must be an object`;
  }
  const { properties, required, additionalProperties } = entry.params;
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      return `${method}: missing required param '${key}'`;
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = properties[key];
    if (!prop) {
      if (!additionalProperties) return `${method}: unknown param '${key}'`;
      continue;
    }
    if (value === undefined) continue;
    // Whole-value templates keep their type until substitute; check shape at runtime.
    if (isWholeValueTemplateParam(value)) continue;
    if (prop.enumValues && !prop.enumValues.includes(value) && !(value === null && prop.nullable)) {
      return `${method}: param '${key}' must be one of ${prop.enumValues.map(String).join(", ")}`;
    }
    if (!kindsMatch(prop, value)) {
      const expect = prop.nullable ? [...prop.kinds, "null"].join("|") : prop.kinds.join("|");
      return `${method}: param '${key}' expects ${expect}`;
    }
  }
  return undefined;
}

/** Schema params then explicit-target policy — shared load-time and runtime gate. */
export function validateHerdrInvocation(
  method: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  return validateMethodParams(method, params) ?? assertFocusPolicy(method, params);
}

function pathAllowed(paths: readonly string[], fieldPath: string): boolean {
  if (paths.includes(fieldPath)) return true;
  const prefix = `${fieldPath}.`;
  return paths.some((path) => path.startsWith(prefix));
}

/** True when `fieldPath` exists on at least one success variant of `method`. */
export function isMethodResultDotPath(method: string, fieldPath: string): boolean {
  const variants = METHOD_RESULT_VARIANTS.get(method);
  if (!variants) return false;
  return variants.some((variant) => pathAllowed(variant.paths, fieldPath));
}

export type StartupCheckResult =
  | { ok: true; protocol: number; version: string }
  | { ok: false; error: string };

/** Compare live `ping` version/protocol with the pinned manifest minimum and protocol. */
export function checkHerdrStartup(live: {
  protocol: unknown;
  version: unknown;
}): StartupCheckResult {
  const protocol = live.protocol;
  const version = typeof live.version === "string" ? live.version : undefined;
  const installed = version ?? "missing";
  if (typeof protocol !== "number" || !Number.isFinite(protocol)) {
    return {
      ok: false,
      error: `herdr protocol check failed: ping did not return a protocol number (installed=${installed}, required≥${MIN_HERDR_VERSION}; protocol connected=${String(protocol)}, pinned=${HERDR_PROTOCOL})`,
    };
  }
  if (!version || !parseSemver(version)) {
    return {
      ok: false,
      error: `herdr version check failed: ping did not return a semver version (installed=${installed}, required≥${MIN_HERDR_VERSION}; protocol connected=${protocol}, pinned=${HERDR_PROTOCOL})`,
    };
  }
  if (!versionAtLeast(version, MIN_HERDR_VERSION)) {
    return {
      ok: false,
      error: `herdr version too old: installed=${version}, required≥${MIN_HERDR_VERSION}; protocol connected=${protocol}, pinned=${HERDR_PROTOCOL}`,
    };
  }
  if (protocol !== HERDR_PROTOCOL) {
    return {
      ok: false,
      error: `herdr protocol mismatch: connected=${protocol}, pinned=${HERDR_PROTOCOL} (installed=${version}, required≥${MIN_HERDR_VERSION})`,
    };
  }
  return { ok: true, protocol, version };
}
