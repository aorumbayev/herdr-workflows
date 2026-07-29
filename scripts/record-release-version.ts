#!/usr/bin/env bun
/**
 * semantic-release successCmd: persist the published version for later workflow jobs.
 * Writes `.release-version` in the repo root (read by the Export release version step).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`record-release-version: expected x.y.z, got ${JSON.stringify(version)}`);
  process.exit(1);
}

const out = join(import.meta.dir, "..", ".release-version");
writeFileSync(out, `${version}\n`);
console.log(`record-release-version: ${version}`);
