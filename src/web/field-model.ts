// @ts-nocheck
const SECTIONS = [
  { id: "does", title: "what it does" },
  { id: "where", title: "where it runs" },
  { id: "when", title: "when it runs" },
  { id: "fails", title: "if it fails" },
  { id: "other", title: "other keys" },
];

// Words and placement only. Types, bounds, and enumerations come from the served schema,
// so this table cannot contradict it, and a key missing here still renders.
const FIELD_INFO = {
  run: {
    label: "command",
    help: "one command line, or argv one token per line",
    placeholder: 'echo "hello"',
    group: "does",
    order: 1,
  },
  shell: { label: "shell", help: "command-line form only", group: "does", order: 2 },
  agent: { label: "prompt", placeholder: "what the agent should do", group: "does", order: 1 },
  herdr: { label: "method", group: "does", order: 1 },
  params: { label: "params", group: "does", order: 2 },
  workflow: { label: "workflow", placeholder: "workflow name", group: "does", order: 1 },
  inputs: { label: "inputs", group: "does", order: 2 },
  using: {
    label: "profile",
    help: "starts a new agent",
    placeholder: "profile name — empty with no target uses the default profile",
    group: "where",
    order: 1,
  },
  target: {
    label: "target agent",
    help: "prompts an agent that already runs",
    placeholder: "agent name or pane ID",
    group: "where",
    order: 2,
  },
  cwd: {
    label: "working directory",
    placeholder: "path — empty uses the invocation directory",
    group: "where",
    order: 3,
  },
  env: { label: "environment", group: "where", order: 4 },
  "pane.open": { label: "open pane", group: "where", order: 5 },
  "pane.target": {
    label: "split anchor",
    placeholder: "pane ID — empty splits the invocation pane",
    group: "where",
    order: 6,
  },
  "pane.workspace": {
    label: "workspace",
    placeholder: "empty uses the invocation workspace",
    group: "where",
    order: 7,
  },
  "pane.size": {
    label: "pane size %",
    placeholder: "percent of the anchor pane",
    group: "where",
    order: 8,
  },
  "pane.focus": { label: "focus the new pane", group: "where", order: 9 },
  "pane.close": { label: "close the pane", group: "where", order: 10 },
  when: {
    label: "condition",
    help: "one clause, or a list of clauses that all must hold",
    placeholder: '{{steps.build.exit_code}} == "0"',
    group: "when",
    order: 1,
  },
  background: { label: "run in the background", group: "when", order: 2 },
  ready_when: {
    label: "ready when",
    help: "regex the pane output must match",
    placeholder: "/regex/ such as /listening/",
    group: "when",
    order: 3,
  },
  timeout: { label: "timeout", placeholder: "30s, 5m, 1h", group: "fails", order: 1 },
  "retry.attempts": {
    label: "attempts",
    placeholder: "includes the first try",
    group: "fails",
    order: 2,
  },
  "retry.delay": { label: "delay between attempts", placeholder: "5s", group: "fails", order: 3 },
  success_codes: {
    label: "exit codes that count as success",
    help: "one code per line",
    placeholder: "0",
    group: "fails",
    order: 4,
  },
  continue_on_error: { label: "continue on error", group: "fails", order: 5 },
};

// The only per-verb knowledge left: which payload keys belong to which action.
const PAYLOAD_KEYS = {
  run: ["run", "shell"],
  agent: ["agent", "using", "target"],
  herdr: ["herdr", "params"],
  workflow: ["workflow", "inputs"],
};
const ANY_PAYLOAD_KEY = [
  "run",
  "shell",
  "agent",
  "using",
  "target",
  "herdr",
  "params",
  "workflow",
  "inputs",
];
const MODE_SUFFIX = "::mode";

export function widgetFor(node): { kind: string; [key: string]: unknown } {
  if (!node || typeof node !== "object") return { kind: "json" };
  if (Array.isArray(node.enum)) return { kind: "enum", options: node.enum.map(String) };
  if (Array.isArray(node.anyOf)) return anyOfWidget(node.anyOf);
  if (node.type === "boolean") return { kind: "check" };
  if (node.type === "integer" || node.type === "number")
    return {
      kind: "number",
      min: node.minimum,
      max: node.maximum,
      integer: node.type === "integer",
    };
  if (node.type === "array") return { kind: "list", item: widgetFor(node.items) };
  if (node.type === "object") {
    if (node.properties && Object.keys(node.properties).length)
      return { kind: "group", properties: node.properties };
    const values = node.additionalProperties;
    if (values && values.type === "string") return { kind: "map" };
    return { kind: "json" };
  }
  if (node.type === "string") return { kind: "text" };
  return { kind: "json" };
}

// A branch set that only adds a template pattern to an enumeration keeps the enumeration
// and stays typeable, so a whole-value template is still an option.
function anyOfWidget(branches) {
  const kinds = branches.map(widgetFor);
  const enumerated = kinds.find((k) => k.kind === "enum");
  if (enumerated && kinds.every((k) => k.kind === "enum" || k.kind === "text"))
    return { kind: "enumText", options: enumerated.options };
  const text = kinds.find((k) => k.kind === "text");
  const list = kinds.find((k) => k.kind === "list");
  if (text && list) return { kind: "textOrList", item: list.item };
  return kinds[0] || { kind: "json" };
}

function fieldInfo(key) {
  return FIELD_INFO[key] || { label: key, group: "other", order: 0 };
}

function pushFields(out, key, node) {
  const widget = key === "params" ? { kind: "params" } : widgetFor(node);
  if (widget.kind === "group") {
    for (const child of Object.keys(widget.properties))
      pushFields(out, key + "." + child, widget.properties[child]);
    return;
  }
  const info = fieldInfo(key);
  out.push({
    key,
    widget,
    label: info.label,
    help: info.help || "",
    placeholder: info.placeholder || "",
    group: info.group,
    order: info.order,
  });
}

// Every schema key renders for every verb except another action's payload keys.
// The loader judges the combination; this form never anticipates a rule.
export function stepFields(
  props,
  verb,
): Array<{
  key: string;
  widget: { kind: string; [key: string]: unknown };
  label: string;
  group: string;
  help?: string;
  placeholder?: string;
}> {
  const mine = PAYLOAD_KEYS[verb] || [];
  const out = [];
  for (const key of Object.keys(props || {})) {
    if (key === "id") continue;
    if (ANY_PAYLOAD_KEY.includes(key) && !mine.includes(key)) continue;
    pushFields(out, key, props[key]);
  }
  const rank = (f) => SECTIONS.findIndex((s) => s.id === f.group);
  return out.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.key.localeCompare(b.key));
}

function valueAt(obj, key) {
  let cur = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAt(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[0]] = value;
}

function listText(v) {
  if (!Array.isArray(v)) return v == null ? "" : String(v);
  return v.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
}

function encodeValue(widget, v) {
  if (widget.kind === "check") return v === true;
  if (widget.kind === "map")
    return v && typeof v === "object" ? Object.keys(v).map((k) => ({ k, v: String(v[k]) })) : [];
  if (v === undefined || v === null) return "";
  if (widget.kind === "list" || widget.kind === "textOrList") return listText(v);
  if (widget.kind === "json") return typeof v === "object" ? JSON.stringify(v) : String(v);
  return typeof v === "string" ? v : JSON.stringify(v);
}

// One line per element. A string element keeps its own spacing, including an empty or
// padded argument, so only the trailing line the editor leaves behind is dropped.
function listValue(raw, item) {
  const scalar = item && (item.kind === "number" || item.kind === "json");
  const lines = String(raw ?? "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = scalar ? lines.map((line) => line.trim()).filter((line) => line !== "") : lines;
  if (!kept.length) return undefined;
  return kept.map((line) => {
    if (item && item.kind === "number") return numberValue(line);
    if (item && item.kind === "json") {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    }
    return line;
  });
}

// An element holding a newline has no one-line-per-element form, so the step keeps its own
// value instead of being split into different elements.
function rendersValue(widget, raw) {
  if (widget.kind !== "list" && widget.kind !== "textOrList") return true;
  if (!Array.isArray(raw)) return true;
  return !raw.some((item) => typeof item === "string" && item.indexOf("\n") >= 0);
}

// A value the schema cannot accept is passed through so the loader answers on the field,
// instead of the form inventing its own message.
function numberValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

function jsonValue(raw, label) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(label + " must be valid JSON");
  }
}

function decodeValue(widget, form, key, label) {
  const raw = form[key];
  if (widget.kind === "check") return raw === true ? true : undefined;
  if (widget.kind === "map") {
    const out = {};
    for (const row of Array.isArray(raw) ? raw : []) {
      const name = String(row.k ?? "").trim();
      if (name) out[name] = String(row.v ?? "");
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (widget.kind === "list") return listValue(raw, widget.item);
  if (widget.kind === "textOrList")
    return form[key + MODE_SUFFIX] === "list" ? listValue(raw, widget.item) : trimmedValue(raw);
  if (widget.kind === "number") return numberValue(raw);
  if (widget.kind === "json") return jsonValue(raw, label);
  return trimmedValue(raw);
}

function trimmedValue(raw) {
  const text = String(raw ?? "");
  return text.trim() === "" ? undefined : text;
}

function methodSpec(methods, name) {
  const entry = methods ? methods[String(name ?? "")] : null;
  return entry && entry.params ? entry : null;
}

// A herdr parameter's own specification is the schema for that field.
function paramNode(spec) {
  if (spec.enumValues && spec.enumValues.length)
    return { type: "string", enum: spec.enumValues.map(String) };
  const kind = (spec.kinds && spec.kinds[0]) || "string";
  if (kind === "boolean") return { type: "boolean" };
  if (kind === "integer" || kind === "number") return { type: kind };
  if (kind === "array") return { type: "array", items: {} };
  if (kind === "object") return {};
  return { type: "string" };
}

function paramFields(entry) {
  const props = (entry && entry.params && entry.params.properties) || {};
  const required = (entry && entry.params && entry.params.required) || [];
  return Object.keys(props)
    .sort((a, b) => required.indexOf(b) - required.indexOf(a) || a.localeCompare(b))
    .map((name) => ({
      key: "params." + name,
      name,
      required: required.includes(name),
      widget: widgetFor(paramNode(props[name])),
    }));
}

function paramsIntoForm(form, step, methods) {
  const params = step.params && typeof step.params === "object" ? step.params : {};
  const entry = methodSpec(methods, step.herdr);
  const rest = {};
  const named = new Set(paramFields(entry).map((f) => f.name));
  for (const f of paramFields(entry)) form[f.key] = encodeValue(f.widget, params[f.name]);
  for (const name of Object.keys(params)) if (!named.has(name)) rest[name] = params[name];
  form.params = Object.keys(rest).length ? JSON.stringify(rest) : "";
}

function paramsFromForm(form, methods) {
  const out = jsonValue(form.params, "params") || {};
  for (const f of paramFields(methodSpec(methods, form.herdr))) {
    const v = decodeValue(f.widget, form, f.key, f.name);
    if (v !== undefined) out[f.name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function formFromStep(props, verb, step, methods): Record<string, unknown> {
  const form = { id: typeof step.id === "string" ? step.id : "" };
  for (const f of stepFields(props, verb)) {
    if (f.widget.kind === "params") {
      paramsIntoForm(form, step, methods);
      continue;
    }
    const raw = valueAt(step, f.key);
    if (!rendersValue(f.widget, raw)) continue;
    form[f.key] = encodeValue(f.widget, raw);
    if (f.widget.kind === "textOrList")
      form[f.key + MODE_SUFFIX] = Array.isArray(raw) ? "list" : "text";
  }
  return form;
}

// Live form values → a raw step the /api/format endpoint judges. Nothing entered is
// dropped: a group with an unset required key is still submitted, and the loader answers.
export function stepFromForm(
  props,
  verb,
  form,
  extra,
  methods,
): { step?: Record<string, unknown>; error?: string } {
  const step = Object.assign({}, extra);
  try {
    for (const f of stepFields(props, verb)) {
      if (f.widget.kind === "params") {
        const params = paramsFromForm(form, methods);
        if (params) step.params = params;
        continue;
      }
      if (!(f.key in form)) continue; // a value the form left in YAML stays as it was
      let v = decodeValue(f.widget, form, f.key, f.label);
      if (v === undefined && f.key === verb) v = form[f.key + MODE_SUFFIX] === "list" ? [] : "";
      if (v === undefined) continue;
      setAt(step, f.key, v);
    }
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
  const id = String(form.id ?? "").trim();
  if (id) step.id = id;
  return { step };
}

// Keys this form does not render: carried through untouched and reported as from YAML.
export function extraOf(props, verb, step): Record<string, unknown> {
  const shown = new Set(["id"]);
  for (const f of stepFields(props, verb)) {
    if (!rendersValue(f.widget, valueAt(step, f.key))) continue;
    shown.add(f.key.split(".")[0]);
  }
  const extra = {};
  for (const key of Object.keys(step)) if (!shown.has(key)) extra[key] = step[key];
  return extra;
}

function rowNames(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row.k ?? "").trim())
    .filter((name) => name !== "");
}

function isFieldSet(widget, form, key) {
  if (widget.kind === "check") return form[key] === true;
  if (widget.kind === "map") return rowNames(form[key]).length > 0;
  if (widget.kind === "params")
    return Object.keys(form).some(
      (k) => k.indexOf("params") === 0 && String(form[k] ?? "").trim() !== "",
    );
  return String(form[key] ?? "").trim() !== "";
}

export function sectionSummary(fields, form): string[] {
  const bits = [];
  for (const f of fields) {
    if (!isFieldSet(f.widget, form, f.key)) continue;
    if (f.widget.kind === "check") {
      bits.push(f.label);
      continue;
    }
    if (f.widget.kind === "map") {
      bits.push(rowNames(form[f.key]).join(" "));
      continue;
    }
    const text = String(form[f.key] ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (f.widget.kind === "number") bits.push(f.label + " " + text);
    else bits.push(text.length > 0 && text.length <= 24 ? text : f.label);
  }
  return bits;
}

// ["steps", 2, "retry", "attempts"] → step 2, field "retry.attempts". A path that names
// no step, or an item inside a field's value, addresses the step alone.
export function issueField(path): { index: number; key: string } | null {
  if (!Array.isArray(path) || path[0] !== "steps" || typeof path[1] !== "number") return null;
  const keys = [];
  for (const part of path.slice(2)) {
    if (typeof part !== "string") break;
    keys.push(part);
  }
  return { index: path[1], key: keys.join(".") };
}

// A loader path and a form key need not agree on depth: "retry" addresses the fields the
// group renders, and "env.LANG" addresses the field that holds the whole mapping.
export function addressesField(issueKey, fieldKey): boolean {
  if (!issueKey || !fieldKey) return false;
  return (
    issueKey === fieldKey ||
    fieldKey.indexOf(issueKey + ".") === 0 ||
    issueKey.indexOf(fieldKey + ".") === 0
  );
}
