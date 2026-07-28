import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebServer } from "../src/web/server";

const dirs: string[] = [];
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function servedPage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-web-pres-"));
  dirs.push(root);
  const s = await startWebServer({ repoRoot: root });
  servers.push(s);
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  return await res.text();
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
  test("page exposes theme tokens, control, and highlighted YAML helper", async () => {
    const page = await servedPage();

    expect(page).toContain("--nord0:");
    expect(page).toContain("--nord15:");
    expect(page).toMatch(/:root\[data-theme=["']light["']\]/);
    expect(page).toContain('id="theme-btn"');
    expect(page).toContain("hwf-theme");
    expect(page).toContain("yamlBlock(");
    expect(page).toMatch(/function\s+yamlBlock\s*\(/);

    expect(page).not.toMatch(/\.textContent\s*=\s*[^;]*\.yaml\b/i);

    const yamlClassSites = [...page.matchAll(/className\s*=\s*["']yaml["']/g)];
    expect(yamlClassSites.length).toBe(1);
    const helperIdx = page.indexOf("function yamlBlock");
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(page.indexOf('className = "yaml"')).toBeGreaterThan(helperIdx);
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
});
