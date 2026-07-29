import manifest from "../../herdr-plugin.toml";
import { compareSemver, fetchLatestPublishedRelease, ReleaseCheckError } from "../release-check";

/** Width-bounded list-mode filter-row hint (printable ASCII only). */
export const UPDATE_INDICATOR = "[run hwf update]";

/** Minimum filter field width reserved before the indicator may appear. */
const MIN_FILTER_FIELD = 4;
/** Filter-row prefix `"/ "` plus a separating space before the indicator. */
const FILTER_ROW_OVERHEAD = 3;

export function updateAvailable(embedded: string, latest: string): boolean {
  try {
    return compareSemver(embedded, latest) < 0;
  } catch {
    return false;
  }
}

/**
 * Return the indicator text when `contentWidth` can fit `/ ` + a short filter
 * field + the ASCII hint; otherwise empty (hide rather than truncate meaning).
 */
export function formatFilterUpdateHint(contentWidth: number): string {
  if (contentWidth < FILTER_ROW_OVERHEAD + MIN_FILTER_FIELD + UPDATE_INDICATOR.length) {
    return "";
  }
  return UPDATE_INDICATOR;
}

export type PickerUpdateCheck = {
  check: () => Promise<{ version: string } | null>;
  embeddedVersion: string;
  onNewer: (version: string) => void;
};

/** Fire-and-forget latest-release check; never throws to the caller. */
export function startPickerUpdateCheck(opts: PickerUpdateCheck): void {
  void opts
    .check()
    .then((latest) => {
      if (!latest) return;
      if (!updateAvailable(opts.embeddedVersion, latest.version)) return;
      opts.onNewer(latest.version);
    })
    .catch(() => {
      // Timeout, network, rate-limit, parse — ignore.
    });
}

export async function defaultPickerReleaseCheck(): Promise<{ version: string } | null> {
  try {
    return await fetchLatestPublishedRelease();
  } catch (error) {
    if (error instanceof ReleaseCheckError) return null;
    return null;
  }
}

export function embeddedPluginVersion(): string {
  return String(manifest.version);
}

/** Move process CWD to the invocation repo so Herdr can rename the managed checkout. */
export function leaveManagedCheckout(
  repoRoot: string,
  chdir: (path: string) => void = (p) => process.chdir(p),
): void {
  chdir(repoRoot);
}
