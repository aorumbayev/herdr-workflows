## Why

A workflow cannot name the tab it creates.

The runner already sends a creation label for `pane.open: tab`. That label is hardcoded to the step ID, or `hwf-agent` / `hwf-run` when the step has no ID. An author who wants a readable tab name has no way to set it.

The gap is hard for pipeline workflows that launch interactive agents with `background: true`. Such a step produces no result, so no later step can read the created `tab_id`. `herdr: tab.rename` requires an explicit `tab_id`, and placement anchors must be captured invocation IDs or prior-result IDs, never live UI focus. So the workflow cannot rename a tab that it created itself, and telling the launched agent to run `herdr tab rename` puts host bookkeeping inside the agent prompt.

The runner holds the created tab identity at placement time. It can name the tab there.

## What Changes

- Add optional template-capable text `pane.name` to the `pane:` placement block.
- Apply `pane.name` as the tab label at creation, replacing the step-ID default. `tab.create` takes `label` and `layout.apply` takes `tab_label`, so no second call and no post-placement rename.
- Reject a literal `pane.name` with `pane.open: beside` or `below` at load. A split joins an existing tab, and renaming a tab the workflow did not create is surprising.
- Keep existing-agent `target:` mode unchanged. It already rejects the complete `pane:` block, so `pane.name` is unreachable there.
- Keep a templated `pane.open` loadable with `pane.name`, and apply the name only when placement creates a tab. This matches how `pane.target` and `pane.size` already behave under a templated `open`.
- Regenerate `docs/workflow.schema.json` and describe `pane.name` in `docs/reference.md`.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `workflow-grammar`: **Requirement: Stable pane placement** gains the `pane.name` field, its tab-only load rule, and the creation-time naming rule.

## Impact

- `src/workflow/grammar.ts` — `paneSchema` gains `name`, the pane refinement rejects it on literal `beside`/`below`, `PaneSpec` and `parsePane` carry it.
- `src/engine/agent-turn.ts`, `src/engine/command.ts` — the placement label prefers the rendered `pane.name` over the step-ID default.
- `src/web/field-model.ts` — a presentation entry keeps `pane.name` in the workbench form's placement group instead of the trailing section.
- `docs/workflow.schema.json`, `docs/reference.md`.
- `test/workflows/grammar.test.ts`, `test/engine/pane.test.ts`, `test/engine/runner.test.ts`.
- No new socket method, no host wrapper change, and no dependency change.

## Alternatives

A post-placement `herdr: tab.rename` call from the runner was considered and rejected. It adds a round trip, shows the default name until the rename lands, and adds a failure mode after the pane already exists. The creation label carries the same intent with one call, and a failed creation already fails the step with its own reason.
