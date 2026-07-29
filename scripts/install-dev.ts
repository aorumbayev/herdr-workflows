#!/usr/bin/env bun
/**
 * Portable install:dev — no POSIX redirects or $PWD.
 * Builds, links the plugin, runs native setup, reloads Herdr config.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bun = process.execPath;
const herdr = process.env.HERDR_BIN_PATH?.trim() || "herdr";

function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  const code = result.status ?? 1;
  if (code !== 0 && !opts.allowFail) process.exit(code);
  return code;
}

run(herdr, ["plugin", "unlink", "herdr-workflows"], { allowFail: true });
run(herdr, ["plugin", "link", root]);

const binary = join(root, "bin", "herdr-workflows");
if (existsSync(binary)) {
  run(binary, ["setup"]);
} else {
  run(bun, [join(root, "src", "cli.ts"), "setup"]);
}

run(herdr, ["server", "reload-config"], { allowFail: true });
