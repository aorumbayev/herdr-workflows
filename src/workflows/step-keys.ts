export const COMPOSITE_KEYS = ["run", "agent", "use"] as const;
export const PLACEMENTS = ["here", "tab", "right", "down"] as const;
export const SHELLS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"] as const;

export const V1_STEP_REASONS: Record<string, string> = {
  open: "run: with in: tab",
  wait_for: "wait: /regex/",
  close_source: "a tab.close: step",
  params: "the dotted method's own value map",
  herdr: "a dotted method key (e.g. pane.split:)",
  on_fail: "on_error:",
};
