import { unlink } from "node:fs/promises";
import { EXAMPLES_URL } from "../init";
import { notificationShow } from "../herdr";
import { exportWorkflowBundle } from "../workflow/export";
import type { WorkflowListEntry } from "../workflow/types";

export const EMPTY_CATALOG_MESSAGE =
  "Hi there, looks like you got no runnable workflows, start by creating a new one, browsing examples or importing an existing workflow.";

export const EMPTY_LIST_HINT = `tab runs | ctrl+k | esc`;
export const PALETTE_HINT = `letter fires | esc back`;
export const DELETE_CONFIRM_HINT = `y delete | n cancel | esc`;

export type ResolvedPaletteAction =
  | { id: "new"; route: "new" }
  | { id: "import"; route: "import" }
  | { id: "examples" }
  | { id: "open"; route: string }
  | { id: "share"; entry: WorkflowListEntry }
  | { id: "delete"; entry: WorkflowListEntry };

export function resolvePaletteLetter(
  letter: string,
  selected: WorkflowListEntry | undefined,
): ResolvedPaletteAction | undefined {
  const key = letter.toLowerCase();
  if (key.length !== 1) return undefined;
  if (key === "n") return { id: "new", route: "new" };
  if (key === "i") return { id: "import", route: "import" };
  if (key === "e") return { id: "examples" };
  if (!selected || selected.error) return undefined;
  if (key === "o") return { id: "open", route: `w=${selected.source}:${selected.name}` };
  if (key === "s") return { id: "share", entry: selected };
  if (key === "d") return { id: "delete", entry: selected };
  return undefined;
}

export function formatPaletteBody(selected: WorkflowListEntry | undefined): string {
  const lines = ["n  Create new", "i  Import", "e  Browse examples"];
  if (selected && !selected.error) {
    lines.push(
      `o  Open ${selected.name}`,
      `s  Share ${selected.name} (copy)`,
      `d  Delete ${selected.name}`,
    );
  } else {
    lines.push(
      "o  Open (needs selection)",
      "s  Share (needs selection)",
      "d  Delete (needs selection)",
    );
  }
  return lines.join("\n");
}

async function copyTextToClipboard(text: string): Promise<void> {
  const trySpawn = async (cmd: string[]): Promise<boolean> => {
    try {
      const proc = Bun.spawn(cmd, {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc.stdin.write(text);
      await proc.stdin.end();
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin" && (await trySpawn(["pbcopy"]))) return;
  if (await trySpawn(["wl-copy"])) return;
  if (await trySpawn(["xclip", "-selection", "clipboard"])) return;
  throw new Error("no clipboard command (pbcopy, wl-copy, or xclip)");
}

export async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
  } catch {
    /* opener absence is nonfatal */
  }
}

export async function openExamplesInBrowser(): Promise<void> {
  await openInBrowser(EXAMPLES_URL);
}

export async function shareWorkflowCopy(opts: {
  entry: WorkflowListEntry;
  repoRoot: string;
}): Promise<void> {
  const exported = await exportWorkflowBundle({
    name: opts.entry.name,
    scope: opts.entry.source,
    repoRoot: opts.repoRoot,
  });
  await copyTextToClipboard(exported.command);
  await notificationShow(`Workflow ${opts.entry.name} has been copied to clipboard`);
}

export async function deleteWorkflowFile(entry: WorkflowListEntry): Promise<void> {
  await unlink(entry.file);
}
