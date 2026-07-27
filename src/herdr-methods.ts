import {
  HERDR_METHOD_BY_NAME,
  HERDR_PROTOCOL,
  METHOD_RESULT_VARIANTS,
  MIN_HERDR_VERSION,
  RESULT_DOT_PATHS,
  type PropSpec,
} from "./herdr-methods.generated";

export { HERDR_PROTOCOL, METHOD_RESULT_VARIANTS, MIN_HERDR_VERSION, RESULT_DOT_PATHS };

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

/** Load-time check: unknown / denied method, or params that violate the generated schema. */
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
