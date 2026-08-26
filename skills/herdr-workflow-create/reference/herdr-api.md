# Herdr calls from workflows

Use only:

```yaml
- herdr: <method>
  params: { … }
```

Dotted YAML keys are not actions. The runner never autofills params from UI focus.

## Allowed methods and the selector each one requires

This is the complete allowlist (60 methods, herdr 0.8.2 schema, protocol 20). Anything **not** on
this list fails at load. The loader denies `plugin.*`, `server.*`, `popup.*`, `events.*`,
`session.snapshot`, `integration.*`, `pane.graphics.*`, `agent.view.*`, `pane.report_agent*`,
`pane.release_agent`, and `pane.clear_agent_authority`, even though their namespace prefixes look
allowed. Method names match exactly. There are no wildcards.

Selector required in `params:`

- **none beyond the method's own schema** — `agent.explain` `agent.focus` `agent.get` `agent.list`
  `agent.prompt` `agent.read` `agent.rename` `agent.send_keys` `agent.start` `agent.wait`
  `client.window_title.clear` `client.window_title.set` `notification.show` `pane.close`
  `pane.focus` `pane.get` `pane.input.set` `pane.list` `pane.read` `pane.rename` `pane.report_metadata`
  `pane.send_input` `pane.send_keys` `pane.send_text` `pane.wait_for_output` `ping` `tab.close`
  `tab.focus` `tab.get` `tab.list` `tab.move` `tab.rename` `workspace.close` `workspace.create`
  `workspace.focus` `workspace.get` `workspace.list` `workspace.move` `workspace.rename`
  `workspace.report_metadata` `workspace.move_block` (without its optional `before_workspace_id`,
  it moves the block to the end) `worktree.remove`
- **`pane_id`** — `pane.edges` `pane.focus_direction` `pane.layout` `pane.neighbor`
  `pane.process_info` `pane.resize` `pane.zoom`
- **`target_pane_id`** — `pane.split` (**not** `pane_id` — `pane_id` is not even a valid param there)
- **`caller_pane_id`** — `pane.current` (**not** `pane_id`)
- **`workspace_id`** — `tab.create`
- **exactly one of `workspace_id` | `cwd`** — `worktree.create` `worktree.list` `worktree.open`
- **exactly one of `workspace_id` | `tab_id`** — `layout.apply`
- **exactly one of `tab_id` | `pane_id`** — `layout.set_split_ratio`
- **at least one of `pane_id` | `tab_id`** — `layout.export`
- **`direction` + `pane_id`, or `source_pane_id` + `target_pane_id`** — `pane.swap`
- **`destination:` object** (`type: tab` needs `destination.target_pane_id`, and `type: new_tab`
  needs `destination.workspace_id`) — `pane.move`

**exactly one** means exactly that: `worktree.create` with both `workspace_id` and `cwd` fails to
load. Selector values must be non-null and non-empty at runtime. A whole-value template such as
`"{{context.workspace}}"` satisfies load-time presence. The runner checks it again after substitution.
A template on an unrelated param does not satisfy the requirement.

Usual selector sources: `{{context.workspace}}`, `{{context.tab}}`, `{{context.pane}}`,
`{{context.worktree}}`, `{{context.agent}}`. Worktree actions that take `cwd` accept
`cwd: "{{context.cwd}}"` — the invocation's project root, always set.

## Agent names

`agent.start` requires `name`, and herdr enforces session-wide uniqueness, so a hardcoded name
collides the second time a workflow runs. Derive it from the target pane id in a prior `run:` step,
for example `printf %s "kind-$(printf %s "$PANE" | tr -c 'A-Za-z0-9' '-')"`, then pass `name: "{{steps.<id>.stdout}}"`.

## Confirming param names against the running build

This skill lives outside the herdr-workflows checkout, so `src/`, `docs/`, and
`schemas/` are **not readable**. Do not try to read them. Use these two sources:

1. The method table in this file. It is the complete allowlist (60 methods, 91 known in the
   herdr 0.8.2 schema, protocol 20). Use it as the authority for **method names** and **param names**.
   The selector rules in this file are an extra load-time check.
2. `scripts/validate.sh` — its error text names the exact missing selector, for example
   `pane.split: params.target_pane_id is required`.

Never guess a method or param name from memory.

## Allowlist posture

The loader denies server/plugin lifecycle, identity-authority, experimental graphics, and similar
methods at load time with the invariant they protect. That denylist is an accidental-misuse and
runtime-safety rail, **not** a sandbox. A trusted `run:` can still invoke the complete Herdr CLI
or socket as the current user.

## Authoring warnings

Flag especially destructive or injectable calls to the user (for example
`pane.close`, `tab.close`, `workspace.close`, `layout.apply`, key/text injection,
`worktree.create`) even when the allowlist permits them.

## Results

The step result is the complete structured success payload for the variant Herdr returned.
A reference to a path that exists only on another success variant fails at runtime. The failure
names the received variant and the missing path.

## Split size

`pane.size` is a percentage for the **new** pane. Herdr stores a first-child ratio and clamps
it to 0.1–0.9, so it clamps sizes less than 10 or more than 90.
