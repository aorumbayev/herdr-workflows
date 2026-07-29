import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNERSHIP_FILE, PRODUCT_VERSION } from "./paths";

export type OwnedKind = "symlink" | "copy";

type OwnershipEntry = {
  kind: OwnedKind;
  version: string;
  source?: string;
};

export type OwnershipRegistry = {
  version: string;
  entries: Record<string, OwnershipEntry>;
};

function ownershipPath(binDir: string): string {
  return join(binDir, OWNERSHIP_FILE);
}

export function readOwnership(binDir: string): OwnershipRegistry {
  try {
    const raw = JSON.parse(readFileSync(ownershipPath(binDir), "utf8")) as OwnershipRegistry;
    if (!raw || typeof raw !== "object" || typeof raw.entries !== "object") {
      return { version: PRODUCT_VERSION, entries: {} };
    }
    return { version: raw.version || PRODUCT_VERSION, entries: raw.entries ?? {} };
  } catch {
    return { version: PRODUCT_VERSION, entries: {} };
  }
}

export function writeOwnership(binDir: string, registry: OwnershipRegistry): void {
  writeFileSync(
    ownershipPath(binDir),
    `${JSON.stringify({ ...registry, version: PRODUCT_VERSION }, null, 2)}\n`,
  );
}

export function isOwnedEntry(binDir: string, name: string): boolean {
  return Boolean(readOwnership(binDir).entries[name]);
}
