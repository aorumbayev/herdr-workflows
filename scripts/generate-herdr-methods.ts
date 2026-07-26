#!/usr/bin/env bun
/**
 * Release-time generator: reads schemas/herdr-api.schema.json and emits
 * src/herdr-methods.generated.ts. Do not invoke `herdr api schema` from the plugin build.
 *
 *   bun run schema:herdr
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "schemas", "herdr-api.schema.json");
const outPath = join(root, "src", "herdr-methods.generated.ts");

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  $ref?: string;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
};

type RootSchema = {
  protocol: number;
  schemas: {
    request: JsonSchema & { $defs?: Record<string, JsonSchema>; oneOf?: JsonSchema[] };
    success_response: JsonSchema & { $defs?: Record<string, JsonSchema> };
  };
};

const DENY_REASONS: { match: (method: string) => boolean; reason: string }[] = [
  {
    match: (m) => m === "server.stop",
    reason: "would stop the server running the workflow",
  },
  {
    match: (m) => m.startsWith("server."),
    reason: "server control methods are not available to workflows",
  },
  {
    match: (m) => m.startsWith("plugin."),
    reason: "plugin lifecycle methods are not available to workflows",
  },
  {
    match: (m) => m === "events.subscribe",
    reason: "event subscriptions have no terminating step semantics",
  },
  {
    match: (m) => m === "session.snapshot",
    reason: "whole-session snapshots are not available; use targeted *.list / *.get methods",
  },
  {
    match: (m) => m === "popup.close",
    reason: "popup.close belongs to the picker's own lifecycle",
  },
  {
    match: (m) => m.startsWith("pane.graphics."),
    reason: "pane.graphics.* methods are experimental and feature-gated",
  },
  {
    match: (m) =>
      m === "pane.report_agent" ||
      m === "pane.report_agent_session" ||
      m === "pane.clear_agent_authority" ||
      m === "pane.release_agent",
    reason: "agent-identity authority methods would corrupt herdr's own detection",
  },
];

function isAllowedArea(method: string): boolean {
  if (method === "ping" || method === "notification.show") return true;
  if (method.startsWith("client.window_title.")) return true;
  return ["workspace.", "tab.", "pane.", "worktree.", "agent.", "layout."].some((p) =>
    method.startsWith(p),
  );
}

function denyReason(method: string): string | undefined {
  for (const rule of DENY_REASONS) {
    if (rule.match(method)) return rule.reason;
  }
  if (!isAllowedArea(method)) return `method '${method}' is outside the workflow allowlist`;
  return undefined;
}

function resolveRef(
  root: RootSchema,
  ref: string,
  base: "request" | "success_response",
): JsonSchema {
  const path = ref.replace(/^#\//, "").split("/");
  let cur: unknown = root;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") throw new Error(`bad $ref ${ref}`);
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur == null) throw new Error(`unresolved $ref ${ref} (base ${base})`);
  return cur as JsonSchema;
}

function deref(
  root: RootSchema,
  schema: JsonSchema,
  base: "request" | "success_response",
  seen: Set<string>,
): JsonSchema {
  if (!schema.$ref) return schema;
  if (seen.has(schema.$ref)) return {};
  seen.add(schema.$ref);
  return deref(root, resolveRef(root, schema.$ref, base), base, seen);
}

type PropSpec = {
  kinds: string[];
  nullable: boolean;
  enumValues?: unknown[];
};

type MethodParams = {
  required: string[];
  properties: Record<string, PropSpec>;
  additionalProperties: boolean;
};

function propSpec(root: RootSchema, schema: JsonSchema): PropSpec {
  const resolved = deref(root, schema, "request", new Set());
  const types = new Set<string>();
  let nullable = false;
  let enumValues: unknown[] | undefined;

  const absorb = (s: JsonSchema) => {
    const r = deref(root, s, "request", new Set());
    if (r.const !== undefined) {
      enumValues = enumValues ? [...enumValues, r.const] : [r.const];
      types.add(typeof r.const);
      return;
    }
    if (r.enum) {
      enumValues = enumValues ? [...enumValues, ...r.enum] : [...r.enum];
      for (const v of r.enum) types.add(v === null ? "null" : typeof v);
      return;
    }
    const t = r.type;
    if (Array.isArray(t)) {
      for (const x of t) {
        if (x === "null") nullable = true;
        else types.add(x);
      }
    } else if (typeof t === "string") {
      if (t === "null") nullable = true;
      else types.add(t);
    }
    if (r.anyOf || r.oneOf) {
      for (const alt of r.anyOf ?? r.oneOf ?? []) absorb(alt);
    }
  };
  absorb(resolved);
  if (types.size === 0) types.add("object");
  return { kinds: [...types], nullable, ...(enumValues ? { enumValues } : {}) };
}

function extractParams(root: RootSchema, paramsSchema: JsonSchema): MethodParams {
  const resolved = deref(root, paramsSchema, "request", new Set());
  const properties: Record<string, PropSpec> = {};
  for (const [name, prop] of Object.entries(resolved.properties ?? {})) {
    properties[name] = propSpec(root, prop);
  }
  return {
    required: [...(resolved.required ?? [])],
    properties,
    additionalProperties: resolved.additionalProperties === true,
  };
}

function collectDotPaths(
  root: RootSchema,
  schema: JsonSchema,
  prefix: string,
  out: Set<string>,
  seenRefs: Set<string>,
): void {
  const resolved = schema.$ref
    ? (() => {
        if (seenRefs.has(schema.$ref)) return null;
        seenRefs.add(schema.$ref);
        return resolveRef(root, schema.$ref, "success_response");
      })()
    : schema;
  if (!resolved) return;

  if (resolved.properties) {
    for (const [key, child] of Object.entries(resolved.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      collectDotPaths(root, child, path, out, new Set(seenRefs));
    }
  }
  for (const alt of resolved.oneOf ?? resolved.anyOf ?? []) {
    collectDotPaths(root, alt, prefix, out, new Set(seenRefs));
  }
  if (resolved.items) collectDotPaths(root, resolved.items, prefix, out, new Set(seenRefs));
}

function js(value: unknown): string {
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  const rootSchema = (await Bun.file(schemaPath).json()) as RootSchema;
  const request = rootSchema.schemas.request;
  const variants = request.oneOf ?? [];
  if (variants.length === 0) throw new Error("request.oneOf empty");

  const methods: {
    method: string;
    params: MethodParams;
    denyReason?: string;
  }[] = [];

  for (const variant of variants) {
    const method = variant.properties?.method?.const;
    if (typeof method !== "string") throw new Error("request variant missing method const");
    const paramsNode = variant.properties?.params;
    if (!paramsNode) throw new Error(`no params for ${method}`);
    methods.push({
      method,
      params: extractParams(rootSchema, paramsNode),
      denyReason: denyReason(method),
    });
  }
  methods.sort((a, b) => a.method.localeCompare(b.method));

  const resultRef = rootSchema.schemas.success_response.properties?.result?.$ref;
  if (!resultRef) throw new Error("success_response.properties.result.$ref missing");
  const resultSchema = resolveRef(rootSchema, resultRef, "success_response");
  const resultPaths = new Set<string>();
  collectDotPaths(rootSchema, resultSchema, "", resultPaths, new Set());

  const lines: string[] = [];
  lines.push("// Generated by scripts/generate-herdr-methods.ts — do not edit.");
  lines.push(`// Source: schemas/herdr-api.schema.json (protocol ${rootSchema.protocol})`);
  lines.push("");
  lines.push(`export const HERDR_PROTOCOL = ${rootSchema.protocol} as const;`);
  lines.push(`export const MIN_HERDR_VERSION = "0.7.5";`);
  lines.push("");
  lines.push(
    'export type ParamKind = "string" | "number" | "integer" | "boolean" | "object" | "array";',
  );
  lines.push("");
  lines.push("export type PropSpec = {");
  lines.push("  kinds: ParamKind[];");
  lines.push("  nullable: boolean;");
  lines.push("  enumValues?: readonly unknown[];");
  lines.push("};");
  lines.push("");
  lines.push("export type MethodParamsSpec = {");
  lines.push("  required: readonly string[];");
  lines.push("  properties: Readonly<Record<string, PropSpec>>;");
  lines.push("  additionalProperties: boolean;");
  lines.push("};");
  lines.push("");
  lines.push("export type MethodEntry =");
  lines.push("  | { method: string; allowed: true; params: MethodParamsSpec }");
  lines.push("  | { method: string; allowed: false; reason: string; params: MethodParamsSpec };");
  lines.push("");
  lines.push("const HERDR_METHODS: readonly MethodEntry[] = [");
  for (const m of methods) {
    const paramsLit = js(m.params);
    if (m.denyReason) {
      lines.push(
        `  { method: ${js(m.method)}, allowed: false, reason: ${js(m.denyReason)}, params: ${paramsLit} },`,
      );
    } else {
      lines.push(`  { method: ${js(m.method)}, allowed: true, params: ${paramsLit} },`);
    }
  }
  lines.push("];");
  lines.push("");
  lines.push("export const HERDR_METHOD_BY_NAME: ReadonlyMap<string, MethodEntry> = new Map(");
  lines.push("  HERDR_METHODS.map((m) => [m.method, m]),");
  lines.push(");");
  lines.push("");
  lines.push(
    `export const RESULT_DOT_PATHS: ReadonlySet<string> = new Set(${js([...resultPaths].sort())});`,
  );
  lines.push("");

  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${lines.join("\n")}\n`);
  process.stdout.write(
    `wrote ${outPath} (protocol ${rootSchema.protocol}, ${methods.length} methods, ${resultPaths.size} result paths)\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
