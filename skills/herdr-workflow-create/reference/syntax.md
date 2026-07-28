# Workflow syntax (v1alpha1)

## Document

```yaml
version: v1alpha1 # required
title: optional picker title
description: optional picker subtitle
hidden: true # optional; hide from picker
# inputs: / returns: optional (returns map must be non-empty when set)
on_failure: # optional; entry only
  herdr: notification.show
  params: { title: "{{context.error.message}}" }
steps: # required, non-empty
  - run: [echo, hi]
```

## Inputs

```yaml
inputs:
  branch: text
  base: [main, develop]
  target: profile
  pick:
    type: choice
    options:
      run: [git, branch, --format=%(refname:short)]
    default: main
```

Types: `text`, `choice` (static or `{run: argv}`), `profile`. Only the entry workflow prompts.

## Actions

Exactly one of `agent`, `run`, `herdr`, `workflow`.

### `run:`

- argv list — no shell; templates per element OK
- string — shell; no templates in the command text; use `env:` / `HWF_*`

Result: `{stdout, stderr, exit_code, failed}`.

### `agent:`

```yaml
- agent: |
    Review {{context.selection}}
  using: claude
  pane: { open: beside, size: 40, close: success }
```

or `target: "{{context.agent}}"` for an existing **idle/done** agent (no pane/cwd/env). A busy
target fails before the prompt is sent.

Blocking result: `{response, agent, pane_id}`.

### `herdr:`

Raw `herdr:` calls never autofill targets from live UI focus. Methods such as
`tab.create`, `pane.split`, `pane.zoom`, `layout.apply`, `layout.set_split_ratio`, and
`worktree.*` require their exact selector params (`workspace_id`, `cwd`, `pane_id`,
`target_pane_id`, …) — a template on an unrelated param does not waive that.

```yaml
- herdr: worktree.create
  params:
    workspace_id: "{{context.workspace}}"
    branch: "{{inputs.branch}}"
    focus: true
```

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

## Templates

`{{inputs.*}}`, `{{steps.<id>.*}}`, `{{context.*}}` only.

Context keys: `workspace`, `tab`, `pane`, `worktree`, `agent`, `selection`, `platform`,
`transcript`, `transcript_file`, and recovery-only `error`.

## Pane / background / readiness

```yaml
pane:
  open: tab | beside | below
  size: 40 # new-pane percent; Herdr clamps ratio to 0.1–0.9
  focus: true
  close: success # agent-only
```

Placed `run:` takes **exactly one** of:

```yaml
background: true # fire-and-forget; needs Herdr-owned pane or existing-agent target
```

or

```yaml
ready_when: "/ready/" # requires timeout; recent 80 rows, ANSI stripped
timeout: 30s
```

Do not set both on the same step.

## Control flow

- `when:` scalar truthiness or `==` / `!=`
- `continue_on_error: true`
- `retry: { attempts: 2, delay: 1s }` — local `run:` / `herdr:` only
- entry `on_failure:` once

## Caps

24 KiB `HWF_*` env; 8 MiB per capture; 1,000 dynamic choices / 10s; 30s transcript extractors.
