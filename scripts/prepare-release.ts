#!/usr/bin/env bun
/**
 * Prepare step for semantic-release: write the next version into herdr-plugin.toml and
 * regenerate docs/workflow.schema.json so its $id tracks the release tag.
 * package.json stays at 0.0.0-development and is never the product-version source.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
const repoRoot = join(import.meta.dir, "..");
const defaultToml = join(repoRoot, "herdr-plugin.toml");
const target = process.argv[3] ?? defaultToml;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`prepare-release: expected x.y.z version, got ${JSON.stringify(version)}`);
  process.exit(1);
}

const text = readFileSync(target, "utf8");
if (!/^version\s*=\s*"[^"]+"/m.test(text)) {
  console.error("prepare-release: herdr-plugin.toml has no version field");
  process.exit(1);
}
const next = text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
writeFileSync(target, next);
console.log(`prepare-release: ${target} → ${version}`);

if (target === defaultToml) {
  const schema = spawnSync("bun", ["run", "schema"], { cwd: repoRoot, stdio: "inherit" });
  if ((schema.status ?? 1) !== 0) process.exit(schema.status ?? 1);
  console.log("prepare-release: regenerated docs/workflow.schema.json");
}
