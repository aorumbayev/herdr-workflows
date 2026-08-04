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
import manifest from "../herdr-plugin.toml";

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
  {
    match: (m) => m === "agent.view.set" || m === "agent.view.clear",
    reason: "agent view filters are client UI state, not workflow automation",
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
      if (key === "type" && prefix === "") continue;
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

/** Schema result oneOf is keyed by `type`, not `method`. Map each request method to its success types. */
const METHOD_RESULT_TYPE_OVERRIDES: Record<string, string[]> = {
  ping: ["pong"],
  "pane.wait_for_output": ["output_matched"],
  "events.wait": ["wait_matched"],
  "events.subscribe": ["subscription_started"],
  "agent.wait": ["agent_info"],
  "agent.start": ["agent_started"],
  "agent.prompt": ["agent_prompted"],
  "agent.read": ["pane_read"],
  "agent.view.set": ["agent_view"],
  "agent.view.clear": ["agent_view"],
  "server.reload_config": ["config_reload"],
  "server.reload_agent_manifests": ["agent_manifest_reload"],
  "server.agent_manifests": ["agent_manifest_status"],
  "client.window_title.set": ["client_window_title"],
  "client.window_title.clear": ["client_window_title"],
  "layout.set_split_ratio": ["layout_split_ratio_set"],
  "plugin.link": ["plugin_linked"],
  "plugin.unlink": ["plugin_unlinked"],
  "plugin.pane.open": ["plugin_pane_opened"],
  "plugin.pane.focus": ["plugin_pane_focused"],
  "plugin.pane.close": ["plugin_pane_closed"],
  "plugin.enable": ["plugin_enabled"],
  "plugin.disable": ["plugin_disabled"],
  "plugin.action.invoke": ["plugin_action_invoked"],
  "pane.split": ["pane_info"],
  "pane.get": ["pane_info"],
  "workspace.get": ["workspace_info"],
  "tab.get": ["tab_info"],
  "agent.get": ["agent_info"],
  "workspace.create": ["workspace_created"],
  "workspace.move_block": ["workspace_list"],
  "tab.create": ["tab_created"],
  "worktree.create": ["worktree_created"],
  "worktree.open": ["worktree_opened"],
  "worktree.remove": ["worktree_removed"],
};

const OK_RESULT_METHODS = new Set([
  "server.stop",
  "server.live_handoff",
  "workspace.focus",
  "workspace.rename",
  "workspace.close",
  "workspace.move",
  "workspace.report_metadata",
  "tab.focus",
  "tab.rename",
  "tab.close",
  "tab.move",
  "agent.send_keys",
  "agent.rename",
  "agent.focus",
  "pane.focus",
  "pane.rename",
  "pane.send_text",
  "pane.send_keys",
  "pane.send_input",
  "pane.close",
  "pane.graphics.set",
  "pane.graphics.clear",
  "pane.report_agent",
  "pane.report_agent_session",
  "pane.report_metadata",
  "pane.clear_agent_authority",
  "pane.release_agent",
  "popup.close",
]);

function resultTypesForMethod(method: string, knownTypes: Set<string>): string[] {
  const override = METHOD_RESULT_TYPE_OVERRIDES[method];
  if (override) return override;
  if (OK_RESULT_METHODS.has(method)) return ["ok"];

  const parts = method.split(".");
  const snake = method.replace(/\./g, "_");
  const last = parts[parts.length - 1]!;
  const area = parts[0]!;
  const candidates = [
    snake,
    last === "list" ? `${area}_list` : null,
    last === "create" ? `${area}_created` : null,
    last === "get" ? `${area}_info` : null,
    last === "open" ? `${area}_opened` : null,
    last === "remove" ? `${area}_removed` : null,
  ].filter((value): value is string => value != null);

  const hit = candidates.find((candidate) => knownTypes.has(candidate));
  if (!hit) {
    throw new Error(
      `no success result type mapped for method '${method}' (tried ${candidates.join(", ")})`,
    );
  }
  return [hit];
}

function js(value: unknown): string {
  return JSON.stringify(value);
}

type GeneratedMethod = {
  method: string;
  params: MethodParams;
  denyReason?: string;
};

type MethodResultEntry = {
  method: string;
  variants: { type: string; paths: string[] }[];
};

function extractMethods(rootSchema: RootSchema): GeneratedMethod[] {
  const variants = rootSchema.schemas.request.oneOf ?? [];
  if (variants.length === 0) throw new Error("request.oneOf empty");
  const methods: GeneratedMethod[] = [];
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
  return methods;
}

function extractResultVariantPaths(rootSchema: RootSchema): Map<string, string[]> {
  const resultRef = rootSchema.schemas.success_response.properties?.result?.$ref;
  if (!resultRef) throw new Error("success_response.properties.result.$ref missing");
  const resultSchema = resolveRef(rootSchema, resultRef, "success_response");
  const resultVariants = resultSchema.oneOf ?? [];
  if (resultVariants.length === 0) throw new Error("success result oneOf empty");
  const variantPaths = new Map<string, string[]>();
  for (const variant of resultVariants) {
    const type = variant.properties?.type?.const;
    if (typeof type !== "string") throw new Error("result variant missing type const");
    const paths = new Set<string>();
    collectDotPaths(rootSchema, variant, "", paths, new Set());
    variantPaths.set(type, [...paths].sort());
  }
  return variantPaths;
}

function mapMethodResultVariants(
  methods: GeneratedMethod[],
  variantPaths: Map<string, string[]>,
): MethodResultEntry[] {
  const knownTypes = new Set(variantPaths.keys());
  return methods.map((m) => {
    const types = resultTypesForMethod(m.method, knownTypes);
    for (const type of types) {
      if (!variantPaths.has(type)) {
        throw new Error(`method '${m.method}' maps to unknown result type '${type}'`);
      }
    }
    return {
      method: m.method,
      variants: types.map((type) => ({ type, paths: variantPaths.get(type)! })),
    };
  });
}

/** Schema params Herdr may resolve from live UI focus when omitted. */
const SELECTOR_PARAM = /(?:^target$|_id$)/;

/** Optional list/filter scopes — omission must not become a focus grab. */
const FOCUS_FILTER_OPT_OUT = new Set(["pane.list", "tab.list"]);

/** Optional position anchors Herdr resolves deterministically when omitted (append), never from focus. */
const FOCUS_OPTIONAL_ANCHOR = new Set(["workspace.move_block"]);

/**
 * Multi-selector or non-_id scope pairs that cannot be auto-derived as a single
 * required field. A regenerated method with optional selectors not covered here
 * or by single-field auto-require fails generation until classified.
 */
const FOCUS_EXACTLY_ONE: Record<string, [string, string]> = {
  "layout.apply": ["workspace_id", "tab_id"],
  "layout.set_split_ratio": ["tab_id", "pane_id"],
  "worktree.list": ["workspace_id", "cwd"],
  "worktree.create": ["workspace_id", "cwd"],
  "worktree.open": ["workspace_id", "cwd"],
};

const FOCUS_AT_LEAST_ONE: Record<string, [string, string]> = {
  "layout.export": ["pane_id", "tab_id"],
};

const FOCUS_REQUIRE: Record<string, string> = {
  "pane.split": "target_pane_id",
};

const FOCUS_SPECIAL = new Set(["pane.swap", "pane.move"]);

export type FocusPolicyEntry =
  | { kind: "none" }
  | { kind: "filter" }
  | { kind: "require"; field: string }
  | { kind: "exactlyOne"; fields: [string, string] }
  | { kind: "atLeastOne"; fields: [string, string] }
  | { kind: "swap" }
  | { kind: "move" };

function optionalSelectors(params: MethodParams): string[] {
  const required = new Set(params.required);
  return Object.keys(params.properties)
    .filter((key) => SELECTOR_PARAM.test(key) && !required.has(key))
    .sort();
}

export function focusPolicyForMethod(method: GeneratedMethod): FocusPolicyEntry {
  if (FOCUS_FILTER_OPT_OUT.has(method.method)) return { kind: "filter" };
  if (FOCUS_OPTIONAL_ANCHOR.has(method.method)) return { kind: "none" };
  if (FOCUS_SPECIAL.has(method.method)) {
    if (method.method === "pane.swap") return { kind: "swap" };
    if (method.method === "pane.move") return { kind: "move" };
    throw new Error(`focus policy: special method ${method.method} has no kind mapping`);
  }
  const exactly = FOCUS_EXACTLY_ONE[method.method];
  if (exactly) return { kind: "exactlyOne", fields: exactly };
  const atLeast = FOCUS_AT_LEAST_ONE[method.method];
  if (atLeast) return { kind: "atLeastOne", fields: atLeast };
  const required = FOCUS_REQUIRE[method.method];
  if (required) return { kind: "require", field: required };

  const optional = optionalSelectors(method.params);
  if (optional.length === 0) return { kind: "none" };
  if (optional.length === 1) return { kind: "require", field: optional[0]! };
  throw new Error(
    `focus policy: ${method.method} has optional selectors [${optional.join(", ")}] — classify in FOCUS_REQUIRE / FOCUS_EXACTLY_ONE / FOCUS_AT_LEAST_ONE / FOCUS_FILTER_OPT_OUT / FOCUS_SPECIAL`,
  );
}

function emitGenerated(
  protocol: number,
  methods: GeneratedMethod[],
  methodVariants: MethodResultEntry[],
  resultPaths: string[],
  focusPolicy: Record<string, FocusPolicyEntry>,
): string {
  const lines: string[] = [
    `// Generated by scripts/generate-herdr-methods.ts — do not edit.
// Source: schemas/herdr-api.schema.json (protocol ${protocol})

export const HERDR_PROTOCOL = ${protocol} as const;
export const MIN_HERDR_VERSION = ${js(manifest.min_herdr_version)};

export type ParamKind = "string" | "number" | "integer" | "boolean" | "object" | "array";

export type PropSpec = {
  kinds: ParamKind[];
  nullable: boolean;
  enumValues?: readonly unknown[];
};

export type MethodParamsSpec = {
  required: readonly string[];
  properties: Readonly<Record<string, PropSpec>>;
  additionalProperties: boolean;
};

export type MethodEntry =
  | { method: string; allowed: true; params: MethodParamsSpec }
  | { method: string; allowed: false; reason: string; params: MethodParamsSpec };

export type MethodResultVariant = {
  type: string;
  paths: readonly string[];
};

export type FocusPolicyEntry =
  | { kind: "none" }
  | { kind: "filter" }
  | { kind: "require"; field: string }
  | { kind: "exactlyOne"; fields: readonly [string, string] }
  | { kind: "atLeastOne"; fields: readonly [string, string] }
  | { kind: "swap" }
  | { kind: "move" };

const HERDR_METHODS: readonly MethodEntry[] = [`,
  ];
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
  lines.push(`export const RESULT_DOT_PATHS: ReadonlySet<string> = new Set(${js(resultPaths)});`);
  lines.push("");
  lines.push(
    "export const METHOD_RESULT_VARIANTS: ReadonlyMap<string, readonly MethodResultVariant[]> = new Map([",
  );
  for (const entry of methodVariants) {
    lines.push(`  [${js(entry.method)}, ${js(entry.variants)}],`);
  }
  lines.push("]);");
  lines.push("");
  lines.push(
    `export const HERDR_FOCUS_POLICY: ReadonlyMap<string, FocusPolicyEntry> = new Map(${js(Object.entries(focusPolicy))});`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function buildGeneratedSource(schemaFile = schemaPath): Promise<{
  source: string;
  protocol: number;
  methodCount: number;
  variantCount: number;
  resultPathCount: number;
}> {
  const rootSchema = (await Bun.file(schemaFile).json()) as RootSchema;
  const methods = extractMethods(rootSchema);
  const variantPaths = extractResultVariantPaths(rootSchema);
  const methodVariants = mapMethodResultVariants(methods, variantPaths);
  const resultPaths = [...new Set([...variantPaths.values()].flat())].sort();
  const focusPolicy: Record<string, FocusPolicyEntry> = {};
  for (const method of methods) {
    if (method.denyReason) continue;
    focusPolicy[method.method] = focusPolicyForMethod(method);
  }
  return {
    source: emitGenerated(rootSchema.protocol, methods, methodVariants, resultPaths, focusPolicy),
    protocol: rootSchema.protocol,
    methodCount: methods.length,
    variantCount: variantPaths.size,
    resultPathCount: resultPaths.length,
  };
}

if (import.meta.main) {
  try {
    const built = await buildGeneratedSource();
    await mkdir(dirname(outPath), { recursive: true });
    await Bun.write(outPath, built.source);
    process.stdout.write(
      `wrote ${outPath} (protocol ${built.protocol}, ${built.methodCount} methods, ${built.variantCount} result variants, ${built.resultPathCount} result paths)\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
