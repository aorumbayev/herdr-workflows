import { writeFile } from "node:fs/promises";
import { snapshotPath, type RunSnapshot } from "../../../src/history";

export async function writeTestSnapshot(snapshot: RunSnapshot): Promise<void> {
  await writeFile(snapshotPath(snapshot.id), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}
