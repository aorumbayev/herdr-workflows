# Herdr calls from workflows

Use only:

```yaml
- herdr: <method>
  params: { … }
```

Dotted YAML keys are not actions. Params are never autofilled from UI focus — pass exact
selectors (`pane_id`, `tab_id`, `workspace_id`, `target`, …).

## Allowlist posture

The loader denies server/plugin lifecycle, identity-authority, experimental graphics, and
similar methods at load time with the invariant they protect. That denylist is an
accidental-misuse and runtime-safety rail, **not** a sandbox. A trusted `run:` can still
invoke the complete Herdr CLI or socket as the current user.

Allowed namespaces include `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`,
`layout.*`, plus `notification.show`, `client.window_title.*`, and `ping`.

## Authoring warnings

Import and the workbench flag especially destructive or injectable calls (for example
`pane.close`, `tab.close`, `workspace.close`, `layout.apply`, key/text injection,
`worktree.create`) even when they are allowlisted.

## Results

The step result is the complete structured success payload for the variant Herdr returned.
Referencing a path that exists only on another success variant fails at runtime naming the
received variant and missing path.

## Split size

`pane.size` is a percentage for the **new** pane. Herdr stores a first-child ratio and clamps
it to 0.1–0.9, so sizes below 10 or above 90 are clamped.
