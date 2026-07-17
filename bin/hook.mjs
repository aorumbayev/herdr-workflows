#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiled = join(root, "bin", "herdr-workflows");
const args = process.argv.slice(2);
const cmd = existsSync(compiled)
  ? [compiled, ...args]
  : ["bun", join(root, "src", "cli.ts"), ...args];

const result = spawnSync(cmd[0], cmd.slice(1), {
  stdio: "inherit",
  env: process.env,
  cwd: root,
});
process.exit(result.status ?? 1);
