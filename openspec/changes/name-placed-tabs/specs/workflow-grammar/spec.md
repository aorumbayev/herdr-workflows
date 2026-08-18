## MODIFIED Requirements

### Requirement: Stable pane placement
`agent` and `run` MUST accept a `pane:` block containing only `open`, `target`, `workspace`, `size`, `focus`, `name`, and `close`. `open` MUST be `tab`, `beside`, or `below`. `beside` and `below` MUST accept only `target`, default it to invocation `context.pane`, and map to Herdr right/down splits. `tab` MUST accept only `workspace` and default it to invocation `context.workspace`. `size` MUST be an integer percentage from 1 through 99 for splits, and MUST allocate that amount to the new pane. Foreground panes MUST focus by default. Background panes MUST NOT. Placement MUST use explicit captured IDs and never current UI focus.

`name` MUST be non-empty template-capable text that names the created tab. A literal `open` of `beside` or `below` with `name` MUST be a load error, because a split joins an existing tab. A templated `open` with `name` MUST load, and the name MUST apply only when placement creates a tab. The runner MUST render `name` and pass it as the label of the tab-creating call, so the created tab carries that name before the step's command or agent starts. Omitting `name` MUST keep the step-ID default label. `name` MUST NOT reach an existing-agent `target:` step, which already rejects the complete `pane:` block.

`close` MUST apply only to newly created managed agent panes and MUST be `success` or `always`. Omitting `close` MUST keep the pane. `success` MUST close the pane only after successful settlement and response capture. `always` MUST close the pane after any terminal outcome once a pane exists. Since Herdr 0.8.0, closing the pane that hosts a workspace's last tab closes that workspace. The runner MUST NOT guard against this and MUST keep the step outcome unchanged. Background actions MUST reject `close`. The `pane:` block MUST require `open`. New-agent mode that omits the complete block MUST create a new tab in the invocation workspace, with foreground/background focus defaults unchanged. Run actions MUST reject `pane.close`, because readiness/background runs have no terminal cleanup point.

#### Scenario: Stable split
- **WHEN** the user changes UI focus before an omitted-target `beside` step
- **THEN** the runner splits the invocation pane through explicit `target_pane_id`

#### Scenario: Failed agent with success cleanup
- **WHEN** an agent with `close: success` times out
- **THEN** its pane remains visible for diagnosis

#### Scenario: Named background agent tab
- **WHEN** a `background: true` agent step declares `pane: {open: tab, name: "review {{inputs.branch}}"}`
- **THEN** the created tab carries the rendered name from the moment it opens, with no later rename step

#### Scenario: Name on a split
- **WHEN** a step declares `pane: {open: beside, name: logs}`
- **THEN** loading fails because the split joins a tab the step did not create
