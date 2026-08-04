import { readdirSync } from "node:fs";
import { join } from "node:path";

const archiveDir = join(import.meta.dir, "..", "openspec", "changes", "archive");

let entries: string[] = [];
try {
  entries = readdirSync(archiveDir);
} catch {
  entries = [];
}

if (entries.length > 0) {
  console.error(
    `openspec/changes/archive holds ${entries.length} ${
      entries.length === 1 ? "entry" : "entries"
    }: ${entries.join(", ")}`,
  );
  console.error(
    "Main keeps no archived specs — delete the archived contents; the main specs already carry the sync.",
  );
  process.exit(1);
}
