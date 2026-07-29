# Herdr calls from workflows

Use only:

```yaml
- herdr: <method>
  params: { … }
```

Dotted YAML keys are not actions. Params are never autofilled from UI focus.

## Allowed methods and the selector each one requires

This is the complete allowlist (58 methods). Anything **not** on this list fails at load —
`plugin.*`, `server.*`, `popup.*`, `events.*`, `session.snapshot`, `integration.*`,
`pane.graphics.*`, `agent.view.*`, `pane.report_agent*`, `pane.release_agent` and
`pane.clear_agent_authority` are all denied even though their namespace prefixes look allowed.
Method names match exactly; there are no wildcards.

Selector required in `params:`

- **none beyond the method's own schema** — `agent.explain` `agent.focus` `agent.get` `agent.list`
  `agent.prompt` `agent.read` `agent.rename` `agent.send_keys` `agent.start` `agent.wait`
  `client.window_title.clear` `client.window_title.set` `notification.show` `pane.close`
  `pane.focus` `pane.get` `pane.list` `pane.read` `pane.rename` `pane.report_metadata`
  `pane.send_input` `pane.send_keys` `pane.send_text` `pane.wait_for_output` `ping` `tab.close`
  `tab.focus` `tab.get` `tab.list` `tab.move` `tab.rename` `workspace.close` `workspace.create`
  `workspace.focus` `workspace.get` `workspace.list` `workspace.move` `workspace.rename`
  `workspace.report_metadata` `worktree.remove`
- **`pane_id`** — `pane.edges` `pane.focus_direction` `pane.layout` `pane.neighbor`
  `pane.process_info` `pane.resize` `pane.zoom`
- **`target_pane_id`** — `pane.split` (**not** `pane_id`; `pane_id` is not even a valid param there)
- **`caller_pane_id`** — `pane.current` (**not** `pane_id`)
- **`workspace_id`** — `tab.create`
- **exactly one of `workspace_id` | `cwd`** — `worktree.create` `worktree.list` `worktree.open`
- **exactly one of `workspace_id` | `tab_id`** — `layout.apply`
- **exactly one of `tab_id` | `pane_id`** — `layout.set_split_ratio`
- **at least one of `pane_id` | `tab_id`** — `layout.export`
- **`direction` + `pane_id`, or `source_pane_id` + `target_pane_id`** — `pane.swap`
- **`destination:` object** (`type: tab` needs `destination.target_pane_id`; `type: new_tab` needs
  `destination.workspace_id`) — `pane.move`

**exactly one** means exactly that: giving `worktree.create` both `workspace_id` and `cwd` fails to
load. Selector presence is checked by key, so a template value (`"{{context.workspace}}"`)
satisfies it, and a template on some unrelated param does not.

Usual selector sources: `{{context.workspace}}`, `{{context.tab}}`, `{{context.pane}}`,
`{{context.worktree}}`, `{{context.agent}}`.

## Confirming param names against the running build

This skill is installed outside the herdr-workflows checkout, so its `src/`, `docs/` and
`schemas/` are **not readable** — do not try to read them. Two runtime sources exist instead:

1. The workbench: `GET /api/methods` with the `x-hwf-token` header, on the `hwf web` instance you
   already started. Returns `{method, allowed, reason?, params:{required, properties}}` for all 89
   known methods. Authoritative for **param names**. Reach for it only when a method is missing
   from the table above — the table already covers every method a workflow normally uses, and a
   lookup per step just costs turns. The selector rules above are an extra load-time check layered
   on top of that schema and do not appear in the payload.
2. `scripts/validate.sh` — its error text names the exact missing selector, e.g.
   `pane.split: params.target_pane_id is required`.

Never guess a method or param name from memory.

## Allowlist posture

The loader denies server/plugin lifecycle, identity-authority, experimental graphics, and similar
methods at load time with the invariant they protect. That denylist is an accidental-misuse and
runtime-safety rail, **not** a sandbox. A trusted `run:` can still invoke the complete Herdr CLI
or socket as the current user.

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
