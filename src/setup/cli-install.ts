import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isOwnedEntry,
  readOwnership,
  writeOwnership,
  type OwnedKind,
  type OwnershipRegistry,
} from "./ownership";
import { PRODUCT_VERSION } from "./paths";

export type CliInstallResult = {
  messages: string[];
};

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function mark(registry: OwnershipRegistry, name: string, kind: OwnedKind, source: string): void {
  registry.entries[name] = { kind, version: PRODUCT_VERSION, source };
}

function installPosixName(
  dir: string,
  name: string,
  source: string,
  kind: OwnedKind,
  registry: OwnershipRegistry,
  messages: string[],
): string | null {
  const dest = join(dir, name);
  const owned = isOwnedEntry(dir, name);

  if (entryExists(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(dest), readlinkSync(dest));
      if (kind === "symlink" && target === resolve(source) && owned) {
        messages.push(`${name} already linked at ${dest}`);
        return dest;
      }
      if (!owned) {
        messages.push(`skipped cli install: ${dest} exists and is not owned by herdr-workflows`);
        return null;
      }
      unlinkSync(dest);
    } else if (owned) {
      unlinkSync(dest);
    } else {
      messages.push(`skipped cli install: ${dest} exists and is not owned by herdr-workflows`);
      return null;
    }
  }

  if (kind === "copy") {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    mark(registry, name, "copy", resolve(source));
    messages.push(`copied ${source} → ${dest}`);
    return dest;
  }

  try {
    symlinkSync(source, dest);
    mark(registry, name, "symlink", resolve(source));
    messages.push(`linked ${source} → ${dest}`);
  } catch {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    mark(registry, name, "copy", resolve(source));
    messages.push(`copied ${source} → ${dest} (symlink unavailable)`);
  }
  return dest;
}

export function installCliCommands(opts: {
  binDir: string;
  binary: string;
  ephemeral: boolean;
}): CliInstallResult {
  const messages: string[] = [];
  mkdirSync(opts.binDir, { recursive: true });
  const registry = readOwnership(opts.binDir);

  // Ephemeral roots (herdr temp build checkouts) get one binary copy; `hwf` symlinks to that
  // copy instead of duplicating ~73 MiB or dangling into the moved checkout.
  const primary = installPosixName(
    opts.binDir,
    "herdr-workflows",
    opts.binary,
    opts.ephemeral ? "copy" : "symlink",
    registry,
    messages,
  );
  const hwf =
    opts.ephemeral && primary
      ? { source: primary, kind: "symlink" as const }
      : { source: opts.binary, kind: opts.ephemeral ? ("copy" as const) : ("symlink" as const) };
  installPosixName(opts.binDir, "hwf", hwf.source, hwf.kind, registry, messages);

  writeOwnership(opts.binDir, registry);
  return { messages };
}
