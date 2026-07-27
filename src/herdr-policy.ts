type Params = Record<string, unknown>;

const REQUIRED_TARGET: Record<string, string> = {
  "tab.create": "workspace_id",
  "pane.current": "caller_pane_id",
  "pane.layout": "pane_id",
  "pane.process_info": "pane_id",
  "pane.neighbor": "pane_id",
  "pane.edges": "pane_id",
  "pane.focus_direction": "pane_id",
  "pane.resize": "pane_id",
  "pane.zoom": "pane_id",
  "pane.split": "target_pane_id",
};

const EXACTLY_ONE: Record<string, [string, string]> = {
  "layout.apply": ["workspace_id", "tab_id"],
  "layout.set_split_ratio": ["tab_id", "pane_id"],
  "worktree.list": ["workspace_id", "cwd"],
  "worktree.create": ["workspace_id", "cwd"],
  "worktree.open": ["workspace_id", "cwd"],
};

const AT_LEAST_ONE: Record<string, [string, string]> = {
  "layout.export": ["pane_id", "tab_id"],
};

function present(params: Params, key: string): boolean {
  const value = params[key];
  return value !== undefined && value !== null && value !== "";
}

function explicit(method: string, detail: string): string {
  return `${method}: ${detail} — raw herdr calls never fall back to live herdr focus`;
}

function swapPolicy(method: string, params: Params): string | undefined {
  const direction = present(params, "direction") && present(params, "pane_id");
  const pair = present(params, "source_pane_id") && present(params, "target_pane_id");
  if (direction || pair) return undefined;
  return explicit(
    method,
    "needs direction with pane_id, or both source_pane_id and target_pane_id",
  );
}

function movePolicy(method: string, params: Params): string | undefined {
  const destination = params.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return `${method}: destination must be an object`;
  }
  const dest = destination as Params;
  if (dest.type === "tab" && !present(dest, "target_pane_id")) {
    return explicit(method, "destination type 'tab' needs destination.target_pane_id");
  }
  if (dest.type === "new_tab" && !present(dest, "workspace_id")) {
    return explicit(method, "destination type 'new_tab' needs destination.workspace_id");
  }
  return undefined;
}

/** Pinned herdr 0.7.5 explicit-target policy: omitted selectors must never reach live UI focus. */
export function assertFocusPolicy(method: string, params: Params | undefined): string | undefined {
  const obj = params ?? {};
  const required = REQUIRED_TARGET[method];
  if (required !== undefined && !present(obj, required)) {
    return explicit(method, `params.${required} is required`);
  }
  const one = EXACTLY_ONE[method];
  if (one) {
    const set = one.filter((key) => present(obj, key));
    if (set.length !== 1) return explicit(method, `needs exactly one of ${one.join(" or ")}`);
  }
  const any = AT_LEAST_ONE[method];
  if (any && !any.some((key) => present(obj, key))) {
    return explicit(method, `needs one of ${any.join(" or ")}`);
  }
  if (method === "pane.swap") return swapPolicy(method, obj);
  if (method === "pane.move") return movePolicy(method, obj);
  return undefined;
}

function valueHasTemplate(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some(valueHasTemplate);
  if (value && typeof value === "object") {
    return Object.values(value as Params).some(valueHasTemplate);
  }
  return false;
}

/** Load-time check when params have no templates; templated selectors stay for runtime. */
export function assertFocusPolicyAtLoad(
  method: string,
  params: Params | undefined,
): string | undefined {
  if (params && valueHasTemplate(params)) return undefined;
  return assertFocusPolicy(method, params);
}
