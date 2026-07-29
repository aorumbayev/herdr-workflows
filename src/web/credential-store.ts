import { chmod, mkdir, stat } from "node:fs/promises";

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export type CredentialStoreAssertOpts = {
  chmodFn?: (path: string, mode: number) => Promise<void>;
  statFn?: (path: string) => Promise<{ mode: number }>;
  mkdirFn?: typeof mkdir;
};

/**
 * Ensure `stateDir` is user-only before writing bearer tokens there.
 * Verifies POSIX mode bits after mkdir/chmod.
 */
export async function assertCredentialStoreSafe(
  stateDir: string,
  opts: CredentialStoreAssertOpts = {},
): Promise<void> {
  const chmodFn = opts.chmodFn ?? ((path, mode) => chmod(path, mode));
  const statFn = opts.statFn ?? ((path) => stat(path));
  const mkdirFn = opts.mkdirFn ?? mkdir;

  await mkdirFn(stateDir, { recursive: true, mode: 0o700 });
  await chmodFn(stateDir, 0o700);
  const mode = (await statFn(stateDir)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialStoreError(
      `refusing credential store with group/world access: ${stateDir}`,
    );
  }
}

/** Tighten and verify a directory is user-only. */
export async function tightenPrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const mode = (await stat(dir)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialStoreError(`refusing credential store with group/world access: ${dir}`);
  }
}
