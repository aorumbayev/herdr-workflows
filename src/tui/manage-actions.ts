import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { editInEditor, reloadManage, type ManageState } from "./manage-load";
import { isValidWorkflowName, workflowFilePath } from "./manage-rows";
import { setBrowse } from "./manage-keys";

export type { ManageState } from "./manage-load";
export {
  ensureAndEdit,
  manageHint,
  onFilterInput,
  reloadManage,
  setTab,
  updatePreview,
} from "./manage-load";
export { handleManageKey } from "./manage-keys";

const WORKFLOW_TEMPLATE = "steps:\n  - shell: echo hello\n";

export async function createWorkflow(state: ManageState, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!isValidWorkflowName(name)) {
    state.footer.content = "invalid name · /^[a-z0-9][a-z0-9-_]*$/";
    return;
  }
  const file = workflowFilePath(state.newScope, state.repoRoot, name);
  const other = workflowFilePath(
    state.newScope === "repo" ? "global" : "repo",
    state.repoRoot,
    name,
  );
  if ((await Bun.file(file).exists()) || (await Bun.file(other).exists())) {
    state.footer.content = `'${name}' already exists`;
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, WORKFLOW_TEMPLATE);
  setBrowse(state);
  await editInEditor(state.renderer, file);
  await reloadManage(state);
}
