#!/usr/bin/env bun
/**
 * Run verifyx duplicate-code; skip locally when jscpd has no host binary.
 * Linux CI keeps full coverage via the verify job.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const binDir = join(import.meta.dir, "..", "node_modules", ".bin");
const verifyx = join(binDir, process.platform === "win32" ? "verifyx.exe" : "verifyx");

const result = spawnSync(verifyx, ["duplicate-code", "--max-warnings", "0"], {
  encoding: "utf8",
  env: process.env,
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const combined = `${stdout}\n${stderr}${result.error ? `\n${result.error.message}` : ""}`;

if ((result.status ?? 1) === 0) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(0);
}

if (/Unsupported platform\s+\S+/i.test(combined) || /jscpd has no host binary/i.test(combined)) {
  const platform = `${process.platform}/${process.arch}`;
  process.stdout.write(
    `verify:duplicate-code: skipped — jscpd has no host binary on ${platform} (Linux CI retains coverage)\n`,
  );
  process.exit(0);
}

process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(result.status ?? 1);
