import { HERDR_FOCUS_POLICY } from "./herdr-methods.generated";

type Params = Record<string, unknown>;

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

/**
 * Explicit-target policy: omitted selectors must never reach live UI focus.
 * Classification comes from the generated schema; an unclassified method is rejected.
 */
export function assertFocusPolicy(method: string, params: Params | undefined): string | undefined {
  const obj = params ?? {};
  const policy = HERDR_FOCUS_POLICY.get(method);
  if (policy === undefined) {
    return explicit(method, "needs an explicit target selector (unclassified method)");
  }
  switch (policy.kind) {
    case "none":
    case "filter":
      return undefined;
    case "require":
      if (!present(obj, policy.field)) {
        return explicit(method, `params.${policy.field} is required`);
      }
      return undefined;
    case "exactlyOne": {
      const set = policy.fields.filter((key) => present(obj, key));
      if (set.length !== 1) {
        return explicit(method, `needs exactly one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    }
    case "atLeastOne":
      if (!policy.fields.some((key) => present(obj, key))) {
        return explicit(method, `needs one of ${policy.fields.join(" or ")}`);
      }
      return undefined;
    case "swap":
      return swapPolicy(method, obj);
    case "move":
      return movePolicy(method, obj);
  }
}

/** Load-time alias: selector presence is key-based; template values do not waive it. */
export function assertFocusPolicyAtLoad(
  method: string,
  params: Params | undefined,
): string | undefined {
  return assertFocusPolicy(method, params);
}
