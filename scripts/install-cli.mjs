#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, "bin", "herdr-workflows");
const names = ["herdr-workflows", "hwf"];
const ephemeral = root.split(sep).some((part) => part.startsWith(".tmp-install-"));

function binDir() {
  if (process.env.XDG_BIN_HOME) return process.env.XDG_BIN_HOME;
  return join(homedir(), ".local", "bin");
}

function onPath(dir) {
  const path = process.env.PATH ?? "";
  return path.split(delimiter).some((entry) => entry && resolve(entry) === resolve(dir));
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function installName(dir, name) {
  const dest = join(dir, name);

  if (entryExists(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(dest), readlinkSync(dest));
      if (!ephemeral && target === resolve(binary)) {
        console.log(`${name} already linked at ${dest}`);
        return;
      }
      unlinkSync(dest);
    } else if (ephemeral) {
      unlinkSync(dest);
    } else {
      console.log(`skipped cli install: ${dest} exists and is not a symlink`);
      return;
    }
  }

  if (ephemeral) {
    copyFileSync(binary, dest);
    chmodSync(dest, 0o755);
    console.log(`copied ${binary} → ${dest}`);
    return;
  }

  symlinkSync(binary, dest);
  console.log(`linked ${binary} → ${dest}`);
}

try {
  if (!existsSync(binary)) {
    console.log(`skipped cli install: ${binary} not found (run build first)`);
    process.exit(0);
  }

  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  for (const name of names) installName(dir, name);

  if (!onPath(dir)) {
    console.log(`warning: ${dir} is not on PATH — add it to your shell profile`);
  }
} catch (error) {
  console.log(`skipped cli install: ${error instanceof Error ? error.message : error}`);
}
