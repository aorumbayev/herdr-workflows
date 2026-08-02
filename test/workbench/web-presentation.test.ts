import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressesField,
  extraOf,
  formFromStep,
  issueField,
  sectionSummary,
  stepFields,
  stepFromForm,
  widgetFor,
} from "../../src/web/field-model";
import { startWebServer, type WebServer } from "../../src/workbench";

const dirs: string[] = [];
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function served(): Promise<{ page: string; base: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-web-pres-"));
  dirs.push(root);
  const s = await startWebServer({ repoRoot: root });
  servers.push(s);
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  const url = new URL(s.url);
  return { page: await res.text(), base: `${url.protocol}//${url.host}`, token: s.token };
}

async function servedPage(): Promise<string> {
  return (await served()).page;
}

type Props = Record<string, Record<string, unknown>>;

const model = {
  widgetFor,
  stepFields,
  formFromStep,
  stepFromForm,
  extraOf,
  issueField,
  addressesField,
  sectionSummary,
};

async function stepProps(base: string, token: string): Promise<Props> {
  const res = await fetch(`${base}/api/schema`, { headers: { "x-hwf-token": token } });
  const schema = (await res.json()) as {
    properties: { steps: { items: { properties: Props } } };
  };
  return schema.properties.steps.items.properties;
}

function extractBlock(page: string, startRe: RegExp): string {
  const start = page.search(startRe);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = page.slice(start);
  const open = from.indexOf("{");
  let depth = 0;
  for (let i = open; i < from.length; i++) {
    if (from[i] === "{") depth++;
    else if (from[i] === "}") {
      depth--;
      if (depth === 0) return from.slice(open + 1, i);
    }
  }
  throw new Error("unclosed CSS block");
}

function parseTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = m[1];
    const value = m[2];
    if (name && value) out.set(name, value.trim());
  }
  return out;
}

function parseLiteral(value: string): [number, number, number] | null {
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function mixColor(
  a: [number, number, number],
  pct: number,
  b: [number, number, number],
): [number, number, number] {
  const t = pct / 100;
  return [
    Math.round(a[0] * t + b[0] * (1 - t)),
    Math.round(a[1] * t + b[1] * (1 - t)),
    Math.round(a[2] * t + b[2] * (1 - t)),
  ];
}

function resolveColor(
  tokens: Map<string, string>,
  name: string,
  stack: string[] = [],
): [number, number, number] {
  if (stack.includes(name)) throw new Error("cycle: " + name);
  const raw = tokens.get(name);
  if (!raw) throw new Error("missing token --" + name);
  const literal = parseLiteral(raw);
  if (literal) return literal;
  if (/^white$/i.test(raw)) return [255, 255, 255];
  if (/^black$/i.test(raw)) return [0, 0, 0];
  const varRef = /^var\(--([a-z0-9-]+)\)$/i.exec(raw);
  if (varRef?.[1]) return resolveColor(tokens, varRef[1], [...stack, name]);
  const mix =
    /^color-mix\(\s*in\s+srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*var\(--([a-z0-9-]+)\)\s*\)$/i.exec(
      raw,
    );
  if (mix?.[1] && mix[2] && mix[3]) {
    const a = resolveColor(tokens, mix[1], [...stack, name]);
    const b = resolveColor(tokens, mix[3], [...stack, name]);
    return mixColor(a, Number(mix[2]), b);
  }
  const mixNamed =
    /^color-mix\(\s*in\s+srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*(black|white)\s*\)$/i.exec(
      raw,
    );
  if (mixNamed?.[1] && mixNamed[2] && mixNamed[3]) {
    const a = resolveColor(tokens, mixNamed[1], [...stack, name]);
    const b: [number, number, number] = /^black$/i.test(mixNamed[3]) ? [0, 0, 0] : [255, 255, 255];
    return mixColor(a, Number(mixNamed[2]), b);
  }
  throw new Error("unresolvable --" + name + ": " + raw);
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function lum(rgb: [number, number, number]): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const L1 = lum(a);
  const L2 = lum(b);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

describe("web workbench presentation", () => {
  test("page exposes theme tokens, control, and highlighted YAML display", async () => {
    const page = await servedPage();

    expect(page).toContain("--nord0:");
    expect(page).toContain("--nord15:");
    expect(page).toMatch(/:root\[data-theme=["']light["']\]/);
    expect(page).toContain('id="theme-btn"');
    expect(page).toContain('aria-label="Theme: system"');
    expect(page).toContain("hwf-theme");

    // Share/import YAML is a highlighted <pre class="yaml">, not plain textContent.
    expect(page).toMatch(/className\s*=\s*["']yaml["']/);
    expect(page).toMatch(/innerHTML\s*=\s*highlight\(/);
    expect(page).not.toMatch(/\.textContent\s*=\s*[^;]*\.yaml\b/i);
    expect(page).not.toMatch(/createElement\(\s*["']pre["']\s*\)[\s\S]{0,120}textContent\s*=/);
  });

  test("colour literals appear only inside the two token blocks", async () => {
    const page = await servedPage();
    const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
    let rest = style;
    for (const re of [/:root\s*\{/, /:root\[data-theme=["']light["']\]\s*\{/]) {
      const block = extractBlock(rest, re);
      rest = rest.replace(block, "");
    }
    const leaked = [...rest.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(/gi)].map((m) => m[0]);
    expect(leaked, "colour literal outside token blocks: " + leaked.join(", ")).toEqual([]);
  });

  test("light block declares every dark semantic colour token", async () => {
    const page = await servedPage();
    const dark = parseTokens(extractBlock(page, /:root\s*\{/));
    const light = parseTokens(extractBlock(page, /:root\[data-theme=["']light["']\]\s*\{/));

    const skip = new Set([
      "nord0",
      "nord1",
      "nord2",
      "nord3",
      "nord4",
      "nord5",
      "nord6",
      "nord7",
      "nord8",
      "nord9",
      "nord10",
      "nord11",
      "nord12",
      "nord13",
      "nord14",
      "nord15",
      "radius",
      "radius-sm",
      "mono",
    ]);
    for (const name of dark.keys()) {
      if (skip.has(name) || name.startsWith("nord")) continue;
      expect(light.has(name), `light missing --${name}`).toBe(true);
    }
  });

  test("ink, muted, and tok-* meet WCAG AA contrast in both themes", async () => {
    const page = await servedPage();
    const dark = parseTokens(extractBlock(page, /:root\s*\{/));
    // The light block overrides semantics only; the Nord palette itself stays in :root.
    const light = new Map([
      ...dark,
      ...parseTokens(extractBlock(page, /:root\[data-theme=["']light["']\]\s*\{/)),
    ]);

    const check = (tokens: Map<string, string>, label: string) => {
      const surface = resolveColor(tokens, "bg");
      for (const name of ["ink", "muted"] as const) {
        const ratio = contrast(resolveColor(tokens, name), surface);
        expect(ratio, `${label} --${name} vs --bg`).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of tokens.keys()) {
        if (!name.startsWith("tok-")) continue;
        const ratio = contrast(resolveColor(tokens, name), surface);
        expect(ratio, `${label} --${name} vs --bg`).toBeGreaterThanOrEqual(4.5);
      }
    };

    check(dark, "dark");
    check(light, "light");
  });

  test("canvas hierarchy tokens distinguish node surface, border, port, and edge", async () => {
    const page = await servedPage();
    const dark = parseTokens(extractBlock(page, /:root\s*\{/));
    const light = new Map([
      ...dark,
      ...parseTokens(extractBlock(page, /:root\[data-theme=["']light["']\]\s*\{/)),
    ]);

    for (const name of [
      "node-surface",
      "node-border",
      "node-shadow",
      "port",
      "edge",
      "canvas-bg",
    ]) {
      expect(dark.has(name), `dark missing --${name}`).toBe(true);
      expect(light.has(name), `light missing --${name}`).toBe(true);
    }

    const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
    expect(style).toMatch(/\.node\s*\{[^}]*background:\s*var\(--node-surface\)/);
    expect(style).toMatch(/\.node\s*\{[^}]*border:[^;]*var\(--node-border\)/);
    expect(style).toMatch(/\.node\s*\{[^}]*box-shadow:\s*var\(--node-shadow\)/);
    expect(style).toMatch(/\.node\s*\.port\s*\{[^}]*background:\s*var\(--port\)/);
    expect(style).toMatch(/\.canvas\s*\.edges\s*path\s*\{[^}]*stroke:\s*var\(--edge\)/);

    for (const [tokens, label] of [
      [dark, "dark"],
      [light, "light"],
    ] as const) {
      const canvas = resolveColor(tokens, "canvas-bg");
      const surface = resolveColor(tokens, "node-surface");
      const border = resolveColor(tokens, "node-border");
      const edge = resolveColor(tokens, "edge");
      const port = resolveColor(tokens, "port");
      expect(
        surface.join(",") !== canvas.join(","),
        `${label} node-surface must differ from canvas-bg`,
      ).toBe(true);
      expect(
        border.join(",") !== canvas.join(","),
        `${label} node-border must differ from canvas-bg`,
      ).toBe(true);
      expect(contrast(edge, canvas), `${label} --edge vs --canvas-bg`).toBeGreaterThanOrEqual(1.4);
      expect(contrast(port, canvas), `${label} --port vs --canvas-bg`).toBeGreaterThanOrEqual(1.4);
    }
  });

  test("editor exposes accessible dirty state, history, and expanded canvas controls", async () => {
    const page = await servedPage();

    // User-visible dirty / save / delete copy (product contract).
    expect(page).toContain("unsaved changes");
    expect(page).toContain("discard unsaved workflow changes?");
    expect(page).toContain('"not saved — "');
    expect(page).toContain('"not deleted — "');
    expect(page).not.toContain("move to ");
    expect(page).not.toContain("run in a terminal:");

    // Accessibility names and menu roles — setAttribute strings are the served a11y contract.
    expect(page).toContain('setAttribute("aria-label", "Undo")');
    expect(page).toContain('setAttribute("aria-label", "Redo")');
    expect(page).toContain('setAttribute("aria-label", "Save")');
    expect(page).toContain('setAttribute("aria-label", "Add step")');
    expect(page).toContain('setAttribute("aria-label", "Keyboard shortcuts")');
    expect(page).toContain('name: "Fit canvas"');
    expect(page).toContain('name: "Expand canvas"');
    expect(page).toContain("Exit expanded canvas");
    expect(page).toContain('name: "Reset zoom"');
    expect(page).toContain('"More actions"');
    expect(page).toContain('setAttribute("aria-haspopup", "menu")');
    expect(page).toContain('setAttribute("role", "menu")');
    expect(page).toContain('setAttribute("role", "menuitem")');

    // List collapse chrome (static markup + a11y).
    expect(page).toContain('id="list-rail"');
    expect(page).toContain('aria-label="Show workflow list"');
    expect(page).toContain('aria-label", "Hide workflow list"');
    expect(page).toContain('aria-controls="list"');
    expect(page).not.toContain('id="list-btn"');

    // Served CSS: expanded canvas, touch targets, responsive layout, collapse.
    expect(page).toContain("canvas-expanded");
    expect(page).toContain(".canvas.expanded");
    expect(page).toContain(".viewbar");
    expect(page).toContain(".zoombar");
    expect(page).toContain(".list-actions");
    expect(page).toContain(".list-chrome");
    expect(page).toContain(".bar-spacer");
    expect(page).toContain("list-collapsed");
    expect(page).toMatch(/\.zoombar\s*button\s*,\s*\.viewbar\s*button\s*\{[^}]*min-height:\s*32px/);
    expect(page).toMatch(/\.bar\s*button\s*\{[^}]*min-height:\s*32px/);
    expect(page).toMatch(/@media\s*\(max-width:\s*720px\)/);
    expect(page).toMatch(/@media\s*\(max-width:\s*480px\)/);
    expect(page).toContain("flex: 1 0 100%");
    expect(page).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(page).toMatch(/\.hide\s*\{\s*display:\s*none\s*!important/);
    expect(page).toMatch(/\.canvas\s*\{[^}]*flex:\s*1 1 auto/);
    expect(page).toContain(".status:empty");

    // Moves are one server-side request: no client-side write-then-delete sequence.
    expect(page).not.toMatch(/method:\s*"DELETE",\s*\n\s*body: JSON.stringify\(\{ name: prev/);
  });
});

describe("node form field model", () => {
  test("every step key resolves to a typed widget, and the page restates no bound", async () => {
    const { page, base, token } = await served();
    const props = await stepProps(base, token);
    for (const [key, node] of Object.entries(props)) {
      const kind = model.widgetFor(node).kind;
      // `params` is the one key whose values the schema leaves unconstrained.
      if (key === "params") expect(kind).toBe("json");
      else expect(kind, `${key} fell back to JSON entry`).not.toBe("json");
    }
    expect(model.widgetFor(props.shell)).toMatchObject({
      kind: "enum",
      options: ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"],
    });
    const pane = props.pane as { properties: Props };
    expect(model.widgetFor(pane.properties.size)).toMatchObject({
      kind: "number",
      min: 1,
      max: 99,
    });
    expect(model.widgetFor(pane.properties.open)).toMatchObject({
      kind: "enumText",
      options: ["tab", "beside", "below"],
    });
    // Bounds and enumerations come from the served schema, never from the page.
    expect(page).not.toContain("pane.size must be");
    expect(page).not.toMatch(/\bfunction (fieldsFor|readPane|formFrom|stepFrom)\b/);
    expect(page).not.toContain('"powershell"');
  });

  test("step to form to step preserves every key the form renders", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const step = {
      id: "build",
      run: ["echo", "hi {{inputs.name}}"],
      shell: "bash",
      cwd: "/tmp",
      env: { LEVEL: "2" },
      pane: { open: "beside", size: 40, focus: true, close: "success" },
      background: true,
      timeout: "30s",
      retry: { attempts: 3, delay: "5s" },
      success_codes: [0, 3],
      when: ["{{inputs.go}}", '"{{context.platform}}" == "macos"'],
      continue_on_error: true,
    };
    const form = model.formFromStep(props, "run", step, {});
    const back = model.stepFromForm(props, "run", form, model.extraOf(props, "run", step), {});
    expect(back.error).toBeUndefined();
    expect(back.step).toEqual(step);
  });

  test("an argv element keeps its own spacing", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    // Empty and padded arguments are legal argv, and the line widget must not rewrite them.
    const step = { run: ["printf", "%s|%s|", "", "  padded  "] };
    const form = model.formFromStep(props, "run", step, {});
    const back = model.stepFromForm(props, "run", form, model.extraOf(props, "run", step), {});
    expect(back.step).toEqual(step);
    // Codes are scalars, so a stray blank line there is still noise rather than a value.
    const codes = model.formFromStep(props, "run", { run: "echo hi", success_codes: [0, 3] }, {});
    codes.success_codes = "0\n\n 3 \n";
    expect(model.stepFromForm(props, "run", codes, {}, {}).step?.success_codes).toEqual([0, 3]);
  });

  test("an argv element holding a newline stays in YAML", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const step = { run: ["python", "-c", "import sys\nprint(1)"] };
    // One line per element cannot express it, so the form carries the value instead of splitting it.
    const extra = model.extraOf(props, "run", step);
    expect(extra).toEqual({ run: step.run });
    const form = model.formFromStep(props, "run", step, {});
    expect(form.run).toBeUndefined();
    expect(model.stepFromForm(props, "run", form, extra, {}).step).toEqual(step);
  });

  test("a placement value survives an unset required sibling", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const form = model.formFromStep(props, "run", { run: "echo hi" }, {});
    form["pane.size"] = "40";
    form["pane.target"] = "{{steps.one.pane_id}}";
    const back = model.stepFromForm(props, "run", form, {}, {});
    expect(back.step?.pane).toEqual({ size: 40, target: "{{steps.one.pane_id}}" });
  });

  test("herdr params round-trip through the generated method specification", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const res = await fetch(`${base}/api/methods`, { headers: { "x-hwf-token": token } });
    const { methods } = (await res.json()) as { methods: { method: string }[] };
    const table: Record<string, unknown> = {};
    for (const m of methods) table[m.method] = m;
    const step = { herdr: "notification.show", params: { title: "done", sound: "done" } };
    const form = model.formFromStep(props, "herdr", step, table);
    expect(form["params.title"]).toBe("done");
    expect(form.params).toBe("");
    // Switching method keeps values the new specification also names.
    form.herdr = "client.window_title.set";
    const back = model.stepFromForm(props, "herdr", form, {}, table);
    expect(back.step?.params).toEqual({ title: "done" });
  });

  test("fields carry empty-state placeholders", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const byKey: Record<string, { placeholder?: string }> = {};
    for (const f of model.stepFields(props, "agent")) byKey[f.key] = f;
    // Fields with a silent default say what empty means; format fields show an example.
    expect(byKey.using?.placeholder).toContain("default profile");
    expect(byKey.target?.placeholder).toContain("agent name");
    expect(byKey.cwd?.placeholder).toContain("invocation directory");
    expect(byKey["pane.target"]?.placeholder).toContain("pane");
    expect(byKey["pane.workspace"]?.placeholder).toContain("workspace");
    expect(byKey.timeout?.placeholder).toContain("30s");
    // A key without a presentation entry still renders, with no placeholder.
    const grown = Object.assign({ nudge: { type: "string" } }, props) as Props;
    const nudge = model.stepFields(grown, "run").find((f) => f.key === "nudge");
    expect(nudge?.placeholder).toBe("");
  });

  test("issue paths address the field they name", async () => {
    expect(model.issueField(["steps", 2, "retry", "attempts"])).toEqual({
      index: 2,
      key: "retry.attempts",
    });
    expect(model.issueField(["steps", 0, "success_codes", 1])).toEqual({
      index: 0,
      key: "success_codes",
    });
    expect(model.issueField(["steps", 1])).toEqual({ index: 1, key: "" });
    expect(model.issueField(["version"])).toBeNull();
    expect(model.issueField(["on_failure", "retry"])).toBeNull();
  });

  test("an issue on a group addresses the fields that group renders", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    // `background: rejects retry` names the group, and the form renders its parts.
    const at = model.issueField(["steps", 0, "retry"]);
    const rendered = model
      .stepFields(props, "run")
      .filter((f) => model.addressesField(at?.key ?? "", f.key))
      .map((f) => f.key);
    expect(rendered).toEqual(["retry.attempts", "retry.delay"]);
    // A path deeper than the field that holds the value still addresses that field.
    expect(model.addressesField("env.LANG", "env")).toBe(true);
    expect(model.addressesField("timeout", "timeout")).toBe(true);
    expect(model.addressesField("retry", "timeout")).toBe(false);
    expect(model.addressesField("", "timeout")).toBe(false);
    // A key no rendered field carries stays reportable elsewhere.
    expect(model.stepFields(props, "run").some((f) => model.addressesField("nudge", f.key))).toBe(
      false,
    );
  });

  test("a schema key with no presentation entry lands in the trailing section", async () => {
    const { base, token } = await served();
    const props = await stepProps(base, token);
    const grown = Object.assign({ nudge: { type: "string" } }, props) as Props;
    const fields = model.stepFields(grown, "run");
    const nudge = fields.find((f) => f.key === "nudge");
    expect(nudge).toMatchObject({ group: "other", label: "nudge" });
    expect(nudge?.widget.kind).toBe("text");
    expect(fields[fields.length - 1]?.key).toBe("nudge");
    // A key the served schema does not describe is not a field at all: it is carried over.
    const step = { run: "echo hi", from_yaml: { deep: true } };
    expect(model.extraOf(props, "run", step)).toEqual({ from_yaml: { deep: true } });
    const back = model.stepFromForm(
      props,
      "run",
      model.formFromStep(props, "run", step, {}),
      model.extraOf(props, "run", step),
      {},
    );
    expect(back.step?.from_yaml).toEqual({ deep: true });
  });

  test("a section summarises what is set and the form marks the field with an issue", async () => {
    const { page, base, token } = await served();
    const props = await stepProps(base, token);
    const form = model.formFromStep(
      props,
      "run",
      { run: "echo hi", timeout: "30s", retry: { attempts: 3 } },
      {},
    );
    const fails = model.stepFields(props, "run").filter((f) => f.group === "fails");
    expect(model.sectionSummary(fails, form)).toEqual(["30s", "attempts 3"]);
    expect(
      model.sectionSummary(
        model.stepFields(props, "run").filter((f) => f.group === "when"),
        form,
      ),
    ).toEqual([]);
    // Sections expose expand state; validation issues from the format API are applied to the form.
    expect(page).toContain('setAttribute("aria-expanded"');
    expect(page).toContain("r.data.issues");
  });

  test("served page inlines executable field-model JavaScript", async () => {
    const page = await servedPage();
    const start = page.indexOf("function widgetFor(");
    const end = page.indexOf("// The two generated sources the field model reads");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const js = page.slice(start, end);
    expect(js).not.toMatch(/function\s+\w+\([^)]*\)\s*:/);
    expect(js).not.toMatch(/^export /m);
    const api = new Function(`${js}; return { widgetFor, addressesField };`)() as {
      widgetFor: (node: unknown) => { kind: string };
      addressesField: (issueKey: string, fieldKey: string) => boolean;
    };
    expect(api.widgetFor({ type: "string" })).toEqual({ kind: "text" });
    expect(api.addressesField("timeout", "timeout")).toBe(true);
    expect(api.addressesField("retry", "timeout")).toBe(false);
  });

  test("YAML key autocomplete and sensitivity come from the served schema and validate API", async () => {
    const { page, base, token } = await served();
    const headers = { "x-hwf-token": token, "content-type": "application/json" };
    const schema = (await (
      await fetch(`${base}/api/schema`, { headers: { "x-hwf-token": token } })
    ).json()) as {
      properties: { steps: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(schema.properties)).toContain("version");
    expect(Object.keys(schema.properties.steps.items.properties)).toContain("success_codes");

    // Page loads the schema and derives autocomplete keys from it — no hardcoded key tables.
    expect(page).toContain("/api/schema");
    expect(page).toMatch(/Object\.keys\(/);
    expect(page).not.toMatch(/\bconst TOP_KEYS\b/);
    expect(page).not.toMatch(/\bconst STEP_KEYS\b/);

    // Sensitivity flags are authoritative validate/API output, not browser-side regex tables.
    const validated = (await (
      await fetch(`${base}/api/validate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "sens",
          text: `version: v1alpha1\nsteps:\n  - agent: "see {{context.transcript}}"\n    using: claude\n  - run: [echo, hi]\n`,
        }),
      })
    ).json()) as { ok: boolean; flags: string[] };
    expect(validated.flags).toEqual(expect.arrayContaining(["commands", "transcript"]));
    expect(page).toContain("/api/validate");
    expect(page).toContain("r.data.flags");
    // Stale validate responses must not paint flags for a superseded buffer.
    expect(page).toMatch(/let validateSeq\s*=\s*0/);
    expect(page).toMatch(/ta\.value\s*!==\s*submitted/);
    expect(page).not.toMatch(/next\.push\(["']commands["']\)/);
    expect(page).not.toMatch(/next\.push\(["']transcript["']\)/);
    expect(page).not.toMatch(/pane\.close\|tab\.close\|workspace\.close/);
  });
});
