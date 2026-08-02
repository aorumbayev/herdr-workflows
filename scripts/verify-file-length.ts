import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const MAX_LINES = 2500;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".generated.ts") && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

const findings: { file: string; lines: number }[] = [];
for (const abs of walk(SRC)) {
  const lines = readFileSync(abs, "utf8").split(/\r?\n/).length;
  if (lines > MAX_LINES) {
    findings.push({ file: relative(ROOT, abs).split("\\").join("/"), lines });
  }
}

if (findings.length === 0) {
  console.log(`file-length: src/**/*.ts under ${MAX_LINES} lines (*.generated.ts exempt)`);
  process.exit(0);
}

for (const f of findings.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))) {
  console.log(`${f.file}: ${f.lines} lines (max ${MAX_LINES})`);
}
console.log(
  `\nfile-length: ${findings.length} file${findings.length === 1 ? "" : "s"} over ${MAX_LINES} lines`,
);
process.exit(1);
