import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCredentialStoreSafe } from "../src/web/credential-store";
import { writeEndpointRecord } from "../src/web/endpoint";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("assertCredentialStoreSafe", () => {
  test("accepts a user-only directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-cred-ok-"));
    dirs.push(dir);
    await assertCredentialStoreSafe(dir);
  });

  test("refuses directories that stay group/world-accessible after tighten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-cred-open-"));
    dirs.push(dir);
    await expect(
      assertCredentialStoreSafe(dir, {
        chmodFn: async () => undefined,
        statFn: async () => ({ mode: 0o755 }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CredentialStoreError",
        message: expect.stringContaining(dir),
      }),
    );
  });
});

describe("writeEndpointRecord privacy", () => {
  test("records stay user-only", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "hwf-cred-rec-"));
    dirs.push(stateDir);
    await writeEndpointRecord(
      { repoRoot: "/repo", url: "http://127.0.0.1:9/?token=abc" },
      stateDir,
    );
    const { stat } = await import("node:fs/promises");
    const { endpointRecordPath } = await import("../src/web/endpoint");
    const mode = (await stat(endpointRecordPath("/repo", stateDir))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
