/** Shared GitHub latest-release fetch for `hwf update` and the picker indicator. */

export const RELEASE_REPO = "aorumbayev/herdr-workflows";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const DEFAULT_RELEASE_CHECK_TIMEOUT_MS = 8_000;

export type LatestRelease = {
  tag: string;
  version: string;
};

export class ReleaseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCheckError";
  }
}

/** Strict `v0.x.y` tag → bare `0.x.y` version. */
export function parseReleaseTag(tag: string): LatestRelease {
  const m = /^v(0\.\d+\.\d+)$/.exec(tag.trim());
  if (!m) {
    throw new ReleaseCheckError(
      `latest release tag is not a strict v0.x.y semver: ${JSON.stringify(tag)}`,
    );
  }
  return { tag: `v${m[1]}`, version: m[1]! };
}

/** Compare `0.x.y` versions. Negative when a < b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseParts(a);
  const pb = parseParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

function parseParts(version: string): [number, number, number] {
  const m = /^(0)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new ReleaseCheckError(`expected 0.x.y version, got ${JSON.stringify(version)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export type FetchLatestOptions = {
  timeoutMs?: number;
  url?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Fetch only the latest *published* GitHub Release (drafts are not `/releases/latest`).
 * Network/parse failures throw ReleaseCheckError.
 */
export async function fetchLatestPublishedRelease(
  opts: FetchLatestOptions = {},
): Promise<LatestRelease> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELEASE_CHECK_TIMEOUT_MS;
  const url = opts.url ?? LATEST_RELEASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "herdr-workflows",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new ReleaseCheckError(`latest release request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { tag_name?: unknown; draft?: unknown };
    if (body.draft === true) {
      throw new ReleaseCheckError("latest release endpoint returned a draft");
    }
    if (typeof body.tag_name !== "string") {
      throw new ReleaseCheckError("latest release response missing tag_name");
    }
    return parseReleaseTag(body.tag_name);
  } catch (error) {
    if (error instanceof ReleaseCheckError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ReleaseCheckError(`latest release request timed out after ${timeoutMs}ms`);
    }
    throw new ReleaseCheckError(
      `latest release request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
