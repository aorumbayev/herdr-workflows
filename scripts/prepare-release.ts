#!/usr/bin/env bun
/**
 * Prepare step for semantic-release: write the next version into herdr-plugin.toml only.
 * package.json stays at 0.0.0-development and is never the product-version source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
const target = process.argv[3] ?? join(import.meta.dir, "..", "herdr-plugin.toml");
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
