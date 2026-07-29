import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCredentialStoreSafe,
  CredentialStoreError,
  parseDarwinAclListing,
  parseLinuxAclListing,
} from "../src/web/credential-store";
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
        stripAclFn: async () => undefined,
        readAclFn: async () => [],
      }),
    ).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(
      assertCredentialStoreSafe(dir, {
        chmodFn: async () => undefined,
        statFn: async () => ({ mode: 0o755 }),
        stripAclFn: async () => undefined,
        readAclFn: async () => [],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(dir) });
  });

  test("refuses when a foreign ACL grant survives stripping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-cred-acl-"));
    dirs.push(dir);
    await expect(
      assertCredentialStoreSafe(dir, {
        stripAclFn: async () => undefined,
        readAclFn: async () => [{ principal: "group:everyone", allow: true }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CredentialStoreError",
        message: expect.stringMatching(/foreign ACL grant/),
      }),
    );
    await expect(
      assertCredentialStoreSafe(dir, {
        stripAclFn: async () => undefined,
        readAclFn: async () => [{ principal: "group:everyone", allow: true }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining(dir),
      }),
    );
  });

  test("accepts owner-only ACL grants after strip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hwf-cred-owner-acl-"));
    dirs.push(dir);
    await assertCredentialStoreSafe(dir, {
      stripAclFn: async () => undefined,
      readAclFn: async () => [{ principal: "owner", allow: true }],
      uidFn: () => 501,
    });
  });
});

describe("ACL listing parsers", () => {
  test("parseDarwinAclListing reads numbered ACE lines", () => {
    const grants = parseDarwinAclListing(
      `drwx------@ 2 user  staff  64 Jan 1 00:00 /tmp/x
 0: group:everyone inherited allow list,add_file,search,delete
 1: user:alice allow read,write
`,
    );
    expect(grants).toEqual([
      { principal: "group:everyone", allow: true },
      { principal: "user:alice", allow: true },
    ]);
  });

  test("parseLinuxAclListing ignores base mode entries and keeps named ACEs", () => {
    const grants = parseLinuxAclListing(
      `# file: x
user::rwx
user:bob:rwx
group::r-x
group:staff:r--
mask::rwx
other::---
`,
    );
    expect(grants).toEqual([
      { principal: "user:bob", allow: true },
      { principal: "group:staff", allow: true },
    ]);
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

describe("darwin inherited ACL refusal", () => {
  test("refuses a state dir that keeps an everyone ACE after chmod -N", async () => {
    if (platform() !== "darwin") return;

    const parent = await mkdtemp(join(tmpdir(), "hwf-cred-acl-parent-"));
    dirs.push(parent);
    const acl = spawnSync(
      "/bin/chmod",
      [
        "+a",
        "everyone allow read,write,execute,delete,add_file,add_subdirectory,file_inherit,directory_inherit",
        parent,
      ],
      { encoding: "utf8" },
    );
    expect(acl.status).toBe(0);

    const stateDir = join(parent, "state");
    // Strip is best-effort; inject a reader that still sees the inherited ACE so the
    // refusal path is what we prove — and separately prove real chmod -N clears it.
    const listedBefore = spawnSync("/bin/ls", ["-lde", parent], { encoding: "utf8" });
    expect(listedBefore.stdout).toContain("group:everyone");

    const child = join(parent, "child");
    spawnSync("/bin/mkdir", ["-m", "700", child]);
    const inherited = spawnSync("/bin/ls", ["-lde", child], { encoding: "utf8" });
    expect(inherited.stdout).toMatch(/group:everyone.*allow/);

    // Real strip clears inheritable ACE on the child.
    spawnSync("/bin/chmod", ["-N", child]);
    const cleared = spawnSync("/bin/ls", ["-lde", child], { encoding: "utf8" });
    expect(cleared.stdout).not.toMatch(/^\s*\d+:/m);

    // Mode-only check would accept; foreign ACL must still refuse.
    await expect(
      assertCredentialStoreSafe(stateDir, {
        stripAclFn: async () => undefined,
        readAclFn: async () => [{ principal: "group:everyone", allow: true }],
      }),
    ).rejects.toMatchObject({
      name: "CredentialStoreError",
      message: expect.stringContaining(stateDir),
    });
  });
});
