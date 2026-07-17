import { loadConfig } from "../config";
import { readInvocationContext } from "../context";
import { listWorkflows } from "../workflows";
import { resolveRepoRoot } from "../repo";
import { runPickerSession } from "../tui/picker";
import { die } from "./popup";

export async function runPickerPopup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die("picker requires a tty");

  const ctx = readInvocationContext();
  const root = process.env.HERDR_WORKFLOWS_REPO_ROOT ?? (await resolveRepoRoot(ctx.cwd));
  const { agents, sessions } = await loadConfig(root);
  const entries = await listWorkflows(root, Object.keys(agents));
  if (entries.length === 0) die("no workflows found");

  ctx.cwd = root;
  const code = await runPickerSession({
    entries,
    repoRoot: root,
    agents,
    sessions,
    ctx,
  });
  process.exit(code);
}
