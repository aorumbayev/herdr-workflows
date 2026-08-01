import { writeFile } from "node:fs/promises";
import { snapshotPath } from "../../src/history/store";
import type { RunSnapshot } from "../../src/history/types";

export async function writeTestSnapshot(snapshot: RunSnapshot): Promise<void> {
  await writeFile(snapshotPath(snapshot.id), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}
