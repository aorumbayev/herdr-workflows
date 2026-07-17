#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, "bin", "herdr-workflows");
const names = ["herdr-workflows", "hwf"];

function binDir() {
  if (process.env.XDG_BIN_HOME) return process.env.XDG_BIN_HOME;
  return join(homedir(), ".local", "bin");
}

function onPath(dir) {
  const path = process.env.PATH ?? "";
  return path.split(delimiter).some((entry) => entry && resolve(entry) === resolve(dir));
}

function linkName(dir, name) {
  const link = join(dir, name);

  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(link), readlinkSync(link));
      if (target === resolve(binary)) {
        console.log(`${name} already linked at ${link}`);
        return;
      }
      unlinkSync(link);
    } else {
      console.log(`skipped cli install: ${link} exists and is not a symlink`);
      return;
    }
  }

  symlinkSync(binary, link);
  console.log(`linked ${binary} → ${link}`);
}

try {
  if (!existsSync(binary)) {
    console.log(`skipped cli install: ${binary} not found (run build first)`);
    process.exit(0);
  }

  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  for (const name of names) linkName(dir, name);

  if (!onPath(dir)) {
    console.log(`warning: ${dir} is not on PATH — add it to your shell profile`);
  }
} catch (error) {
  console.log(`skipped cli install: ${error instanceof Error ? error.message : error}`);
}
