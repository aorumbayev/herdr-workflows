import { unlink } from "node:fs/promises";
import type { KeyEvent } from "@opentui/core";
import {
  ensureAndEdit,
  manageHint,
  reloadManage,
  setTab,
  updatePreview,
  type ManageState,
} from "./manage-load";
import { MANAGE_TABS, type ManageRowValue } from "./manage-rows";

export function setBrowse(state: ManageState): void {
  state.mode = "browse";
  state.pendingDelete = undefined;
  state.nameInput.visible = false;
  state.nameInput.value = "";
  state.filter.visible = state.tab !== "config";
  state.list.visible = true;
  state.preview.visible = true;
  state.footer.content = manageHint(state.tab);
  if (state.tab === "config") state.list.focus();
  else state.filter.focus();
}

function handleNameKey(state: ManageState, key: KeyEvent): void {
  if (key.name === "tab") {
    key.preventDefault();
    state.newScope = state.newScope === "repo" ? "global" : "repo";
    state.footer.content = `new workflow · ${state.newScope} · tab scope · enter create · esc cancel`;
  } else if (key.name === "escape") {
    key.preventDefault();
    setBrowse(state);
  }
}

function handleConfirmKey(state: ManageState, key: KeyEvent): void {
  if (key.name === "y") {
    key.preventDefault();
    void (async () => {
      if (state.pendingDelete) await unlink(state.pendingDelete.file);
      setBrowse(state);
      await reloadManage(state);
    })();
  } else if (key.name === "n" || key.name === "escape") {
    key.preventDefault();
    setBrowse(state);
  } else {
    key.preventDefault();
  }
}

function cycleTab(state: ManageState, delta: number): void {
  const i = MANAGE_TABS.findIndex((t) => t.value === state.tab);
  const next = MANAGE_TABS[(i + delta + MANAGE_TABS.length) % MANAGE_TABS.length]!;
  setTab(state, next.value);
}

function startNewWorkflow(state: ManageState): void {
  state.mode = "name";
  state.newScope = "repo";
  state.filter.visible = false;
  state.list.visible = false;
  state.preview.visible = false;
  state.nameInput.visible = true;
  state.nameInput.value = "";
  state.footer.content = `new workflow · ${state.newScope} · tab scope · enter create · esc cancel`;
  state.nameInput.focus();
}

function startDelete(state: ManageState): void {
  const value = state.list.getSelectedOption()?.value as ManageRowValue | undefined;
  if (!value || value.kind !== "workflow") return;
  state.mode = "confirm";
  state.pendingDelete = value;
  state.footer.content = `delete '${value.name}'? [y/N]`;
}

function handleBrowseNav(state: ManageState, key: KeyEvent): boolean {
  if (key.name === "escape" || (key.name === "q" && !state.filter.focused)) {
    key.preventDefault();
    state.renderer.destroy();
    return true;
  }
  if (key.name === "tab") {
    key.preventDefault();
    cycleTab(state, key.shift ? -1 : 1);
    return true;
  }
  if (key.raw === "[" || key.name === "[") {
    key.preventDefault();
    cycleTab(state, -1);
    return true;
  }
  if (key.raw === "]" || key.name === "]") {
    key.preventDefault();
    cycleTab(state, 1);
    return true;
  }
  if (key.name === "up") {
    key.preventDefault();
    state.list.moveUp();
    void updatePreview(state);
    return true;
  }
  if (key.name === "down") {
    key.preventDefault();
    state.list.moveDown();
    void updatePreview(state);
    return true;
  }
  if (key.name === "return" || key.name === "linefeed") {
    key.preventDefault();
    const value = state.list.getSelectedOption()?.value as ManageRowValue | undefined;
    if (value) void ensureAndEdit(state, value);
    return true;
  }
  return false;
}

function handleBrowseKey(state: ManageState, key: KeyEvent): void {
  if (handleBrowseNav(state, key)) return;
  if (key.name === "n" && key.ctrl) {
    if (state.tab !== "workflows") return;
    key.preventDefault();
    startNewWorkflow(state);
  } else if (key.name === "x" && key.ctrl) {
    if (state.tab !== "workflows") return;
    key.preventDefault();
    startDelete(state);
  }
}

export function handleManageKey(state: ManageState, key: KeyEvent): void {
  if (state.mode === "name") return handleNameKey(state, key);
  if (state.mode === "confirm") return handleConfirmKey(state, key);
  handleBrowseKey(state, key);
}
