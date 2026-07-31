import { realpath } from "node:fs/promises";

/**
 * Soft canonicalization for display and Current-scope lookups when a checkout may
 * already be deleted. Falls back to the input path when realpath fails.
 */
export async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  try {
    return await realpath(repoRoot);
  } catch {
    return repoRoot;
  }
}

/** Strict realpath for durable claim identity — fails if the checkout is not resolvable. */
export async function requireCanonicalRepoRoot(repoRoot: string): Promise<string> {
  return await realpath(repoRoot);
}
