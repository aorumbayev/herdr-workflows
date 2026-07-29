import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { platform, userInfo } from "node:os";

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export type AclGrant = { principal: string; allow: boolean };

/**
 * Best-effort private credential location check.
 *
 * Mode bits and ACL stripping cover POSIX discretionary access and common ACL
 * inheritance. A filesystem with no permission model (some network mounts) still
 * cannot be proven safe — callers refuse only what the platform can observe.
 */
export type CredentialStoreAssertOpts = {
  chmodFn?: (path: string, mode: number) => Promise<void>;
  statFn?: (path: string) => Promise<{ mode: number }>;
  mkdirFn?: typeof mkdir;
  stripAclFn?: (path: string) => Promise<void>;
  readAclFn?: (path: string) => Promise<AclGrant[] | null>;
  uidFn?: () => number;
};

function runQuiet(
  command: string,
  args: string[],
): {
  status: number | null;
  stdout: string;
  missing: boolean;
} {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const missing = result.error != null && (result.error as NodeJS.ErrnoException).code === "ENOENT";
  return { status: result.status, stdout: result.stdout ?? "", missing };
}

function stripExtendedAcls(path: string): void {
  if (platform() === "darwin") {
    runQuiet("/bin/chmod", ["-N", path]);
    return;
  }
  if (platform() === "linux") {
    const probe = runQuiet("setfacl", ["-b", path]);
    if (probe.missing) return;
  }
}

/** Parse macOS `/bin/ls -lde` / `-le` numbered ACE lines into grants. */
export function parseDarwinAclListing(stdout: string): AclGrant[] {
  const grants: AclGrant[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*\d+:\s+(\S+)(?:\s+inherited)?\s+(allow|deny)\s+/.exec(line);
    if (!match) continue;
    grants.push({ principal: match[1]!, allow: match[2] === "allow" });
  }
  return grants;
}

/** Parse `getfacl -cp` named entries; owning user:/group: blanks are mode bits, not ACEs. */
export function parseLinuxAclListing(stdout: string): AclGrant[] {
  const grants: AclGrant[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(user|group|other|mask):([^:]*):([rwx-]+)/.exec(trimmed);
    if (!match) continue;
    const kind = match[1]!;
    const name = match[2]!;
    const perms = match[3]!;
    if (perms === "---") continue;
    if (kind === "mask") continue;
    if (kind === "user" && name === "") continue;
    if (kind === "group" && name === "") continue;
    if (kind === "other") continue;
    grants.push({ principal: `${kind}:${name}`, allow: true });
  }
  return grants;
}

function readExtendedAcls(path: string): AclGrant[] | null {
  if (platform() === "darwin") {
    const listed = runQuiet("/bin/ls", ["-lde", path]);
    if (listed.status !== 0) {
      const fileListed = runQuiet("/bin/ls", ["-le", path]);
      if (fileListed.status !== 0) return [];
      return parseDarwinAclListing(fileListed.stdout);
    }
    return parseDarwinAclListing(listed.stdout);
  }
  if (platform() === "linux") {
    const listed = runQuiet("getfacl", ["-cp", path]);
    if (listed.missing || listed.status !== 0) return null;
    return parseLinuxAclListing(listed.stdout);
  }
  return null;
}

function ownerPrincipalHints(uid: number): Set<string> {
  const hints = new Set<string>(["owner", "owner@", `user:${uid}`]);
  try {
    const name = userInfo().username;
    if (name) {
      hints.add(name);
      hints.add(`user:${name}`);
    }
  } catch {
    /* ignore */
  }
  return hints;
}

function foreignAllowGrant(grant: AclGrant, ownerHints: Set<string>): boolean {
  if (!grant.allow) return false;
  return !ownerHints.has(grant.principal);
}

function assertModePrivate(path: string, mode: number, kind: "store" | "file"): void {
  if ((mode & 0o077) !== 0) {
    throw new CredentialStoreError(
      kind === "file"
        ? `refusing credential file with group/world access: ${path}`
        : `refusing credential store with group/world access: ${path}`,
    );
  }
}

function assertNoForeignAclAccessSync(path: string, uid: number): void {
  stripExtendedAcls(path);
  const grants = readExtendedAcls(path);
  if (grants === null) return;
  const ownerHints = ownerPrincipalHints(uid);
  for (const grant of grants) {
    if (foreignAllowGrant(grant, ownerHints)) {
      throw new CredentialStoreError(`refusing credential store with foreign ACL grant at ${path}`);
    }
  }
}

async function assertNoForeignAclAccess(
  path: string,
  opts: Pick<CredentialStoreAssertOpts, "stripAclFn" | "readAclFn" | "uidFn"> = {},
): Promise<void> {
  const stripAclFn = opts.stripAclFn ?? (async (p) => stripExtendedAcls(p));
  const readAclFn = opts.readAclFn ?? (async (p) => readExtendedAcls(p));
  const uidFn = opts.uidFn ?? (() => process.getuid?.() ?? -1);

  await stripAclFn(path);
  const grants = await readAclFn(path);
  if (grants === null) return;
  const ownerHints = ownerPrincipalHints(uidFn());
  for (const grant of grants) {
    if (foreignAllowGrant(grant, ownerHints)) {
      throw new CredentialStoreError(`refusing credential store with foreign ACL grant at ${path}`);
    }
  }
}

async function ensurePrivateDir(
  dir: string,
  mode: number,
  opts: CredentialStoreAssertOpts,
): Promise<void> {
  const chmodFn = opts.chmodFn ?? ((path, m) => chmod(path, m));
  const statFn = opts.statFn ?? ((path) => stat(path));
  const mkdirFn = opts.mkdirFn ?? mkdir;

  await mkdirFn(dir, { recursive: true, mode });
  await chmodFn(dir, mode);
  assertModePrivate(dir, (await statFn(dir)).mode & 0o777, "store");
  await assertNoForeignAclAccess(dir, opts);
}

/**
 * Ensure `stateDir` grants no read/write to any principal other than the current
 * user before writing bearer tokens there.
 */
export async function assertCredentialStoreSafe(
  stateDir: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  await ensurePrivateDir(stateDir, 0o700, opts);
}

/** Tighten and verify a directory is private to the current user. */
export async function tightenPrivateDir(
  dir: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  await ensurePrivateDir(dir, 0o700, opts);
}

/** Tighten and verify a credential file is private to the current user. */
export async function assertPrivateCredentialFile(
  path: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  const chmodFn = opts.chmodFn ?? ((p, mode) => chmod(p, mode));
  const statFn = opts.statFn ?? ((p) => stat(p));

  await chmodFn(path, 0o600);
  assertModePrivate(path, (await statFn(path)).mode & 0o777, "file");
  await assertNoForeignAclAccess(path, opts);
}

/** Sync counterpart for lock-file creation on the hot path. */
export function assertPrivateCredentialFileSync(path: string): void {
  chmodSync(path, 0o600);
  assertModePrivate(path, statSync(path).mode & 0o777, "file");
  assertNoForeignAclAccessSync(path, process.getuid?.() ?? -1);
}
