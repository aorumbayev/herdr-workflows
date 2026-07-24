#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const built = join(root, "bin", "herdr-workflows");
const names = ["herdr-workflows", "hwf"];

// `herdr plugin install` runs builds in a temp `.tmp-install-*` checkout, then renames it to the
// managed path below; linking the build-time path leaves a dangling symlink. Mirrors herdr's
// plugin_managed_path_component (slug + sha256(plugin_id)[:12]).
function managedCheckoutBinary() {
  const configBase = process.env.HERDR_CONFIG_PATH
    ? dirname(process.env.HERDR_CONFIG_PATH)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr");
  const id = "herdr-workflows";
  const slug = id.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-{2,}/g, "-");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return join(configBase, "plugins", "github", `${slug}-${hash}`, "bin", "herdr-workflows");
}

const binary = root.includes(".tmp-install-") ? managedCheckoutBinary() : built;

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
  if (!existsSync(built)) {
    console.log(`skipped cli install: ${built} not found (run build first)`);
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
