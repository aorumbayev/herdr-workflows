import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

type Module =
  | "cli"
  | "picker"
  | "workbench"
  | "workflows"
  | "engine"
  | "history"
  | "host"
  | "context";

const LAYER: Record<Module, number> = {
  cli: -1,
  picker: 0,
  workbench: 0,
  workflows: 1,
  engine: 1,
  history: 1,
  host: 2,
  context: 2,
};

/** Outsiders may import only these files from each module. */
const ENTRIES: Record<Module, ReadonlySet<string>> = {
  cli: new Set(["src/cli.ts"]),
  picker: new Set(["src/picker.ts"]),
  workbench: new Set(["src/workbench.ts"]),
  workflows: new Set([
    "src/workflow/load.ts",
    "src/workflow/inputs.ts",
    "src/workflow/types.ts",
    "src/workflow/import.ts",
    "src/workflow/share.ts",
  ]),
  engine: new Set(["src/engine.ts"]),
  history: new Set(["src/history.ts"]),
  host: new Set(["src/host.ts", "src/herdr-methods.generated.ts"]),
  context: new Set(["src/context.ts"]),
};

/** Same-layer module edges that are part of the architecture (not residuals). */
const SIDEWAYS = new Set([
  "engine->history",
  "engine->workflows",
  "picker->workbench",
  "context->host",
]);

/**
 * context: Residual edges the layer rule tolerates until Phase 3 consolidation.
 * - engine → workflow/template: step rendering deep-imports the template engine.
 * - host/context/history → workflow/types: shared grammar types still live under workflows.
 * - context + workflows/inputs dynamic-import engine for spawnCapture (breaks cycles).
 * - picker → cli: update indicator and browser open from the TUI.
 */
const ALLOW: ReadonlySet<string> = new Set([
  "src/picker.ts -> src/cli.ts",
  "src/context.ts -> src/workflow/types.ts",
  "src/host.ts -> src/workflow/types.ts",
  "src/history.ts -> src/workflow/types.ts",
  "src/engine.ts -> src/workflow/template.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function repoPath(abs: string): string {
  return relative(ROOT, abs).split("\\").join("/");
}

function moduleOf(file: string): Module | undefined {
  if (file === "src/picker.ts" || file === "src/chrome.ts") return "picker";
  if (file === "src/workbench.ts" || file.startsWith("src/web/")) return "workbench";
  if (file.startsWith("src/workflow/")) return "workflows";
  if (file === "src/engine.ts") return "engine";
  if (file === "src/history.ts") return "history";
  if (file === "src/host.ts" || file === "src/herdr-methods.generated.ts") {
    return "host";
  }
  if (file === "src/context.ts") return "context";
  if (ENTRIES.cli.has(file)) return "cli";
  return undefined;
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = join(dirname(join(ROOT, from)), spec);
  if (existsSync(base) && statSync(base).isFile()) return repoPath(base);
  if (existsSync(`${base}.ts`)) return repoPath(`${base}.ts`);
  if (existsSync(join(base, "index.ts"))) return repoPath(join(base, "index.ts"));
  return undefined;
}

type Finding = { file: string; message: string };

function checkEdges(files: string[]): Finding[] {
  const re = /from\s+["'](\.[^"']+)["']/g;
  const findings: Finding[] = [];
  for (const file of files) {
    const fromMod = moduleOf(file);
    if (!fromMod) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const to = resolveImport(file, match[1]!);
      if (!to || !to.startsWith("src/") || to.endsWith(".generated.ts")) continue;
      if (to.endsWith(".html") || to.endsWith(".svg") || to.endsWith(".toml")) continue;
      const toMod = moduleOf(to);
      if (!toMod) continue;
      if (fromMod === toMod) continue;
      const key = `${file} -> ${to}`;
      if (ALLOW.has(key)) continue;
      if (LAYER[toMod] < LAYER[fromMod]) {
        findings.push({
          file,
          message: `upward import ${fromMod} → ${toMod}: ${to}`,
        });
        continue;
      }
      if (LAYER[toMod] === LAYER[fromMod] && !SIDEWAYS.has(`${fromMod}->${toMod}`)) {
        findings.push({
          file,
          message: `sideways import ${fromMod} → ${toMod}: ${to}`,
        });
        continue;
      }
      if (!ENTRIES[toMod].has(to)) {
        findings.push({
          file,
          message: `deep import into ${toMod} (not an entry): ${to}`,
        });
      }
    }
  }
  return findings;
}

function checkOpentui(files: string[]): Finding[] {
  const importers: string[] = [];
  const re = /from\s+["']@opentui\/core["']/;
  for (const file of files) {
    if (re.test(readFileSync(join(ROOT, file), "utf8"))) importers.push(file);
  }
  if (importers.length === 1 && importers[0] === "src/chrome.ts") return [];
  return [
    {
      file: "src/chrome.ts",
      message: `@opentui/core importers must be exactly [src/chrome.ts], got [${importers.join(", ") || "(none)"}]`,
    },
  ];
}

const files = walk(SRC)
  .map(repoPath)
  .filter((f) => !f.endsWith(".generated.ts"))
  .sort();
const findings = [...checkEdges(files), ...checkOpentui(files)].sort(
  (a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message),
);

if (findings.length === 0) {
  console.log(`layers: ${files.length} files clean`);
  process.exit(0);
}

for (const f of findings) console.log(`${f.file}: ${f.message}`);
console.log(
  `\nlayers: ${findings.length} issue${findings.length === 1 ? "" : "s"} (surfaces → domain → platform; entry-only cross-module imports; one @opentui/core importer)`,
);
process.exit(1);
