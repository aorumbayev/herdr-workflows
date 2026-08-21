# herdr 0.8.0 breakage classes

Three ways a workflow written for an older herdr breaks on 0.8.0. Each class loads clean — the
failure is at run time, so `hwf workflow inspect` passes on the broken file too. Grep for the
pattern, apply the fix, then re-inspect.

## 1. Worktree actions: `workspace_id` vs `cwd`

`worktree.create` / `worktree.open` / `worktree.list` take exactly one of `workspace_id` or
`cwd` — passing both fails to load, passing neither fails at runtime. The trap is
`workspace_id`: herdr 0.8.0 resolves it only for worktree-backed workspaces, so a step that
targets the invoking workspace breaks whenever the workflow runs from an ordinary repo
workspace.

Before — loads, fails at runtime outside a worktree-backed workspace:

```yaml
version: v1alpha1
title: Open a worktree
description: open an existing worktree by branch
inputs:
  branch:
    type: text
    description: existing worktree branch to open
    min_length: 1
steps:
  - herdr: worktree.open
    params:
      workspace_id: "{{context.workspace}}"
      branch: "{{inputs.branch}}"
      label: "{{inputs.branch}}"
      focus: true
```

After — `{{context.cwd}}` is always set to the invocation's project root:

```yaml
version: v1alpha1
title: Open a worktree
description: open an existing worktree by branch
inputs:
  branch:
    type: text
    description: existing worktree branch to open
    min_length: 1
steps:
  - herdr: worktree.open
    params:
      cwd: "{{context.cwd}}"
      branch: "{{inputs.branch}}"
      label: "{{inputs.branch}}"
      focus: true
```

A step that computes the repo root first (`git rev-parse --show-toplevel` into
`{{steps.<id>.stdout}}`) is already correct — leave it. Only `workspace_id` selectors and
hardcoded paths need the change.

## 2. `agent.start` names are unique per session

herdr 0.8.0 enforces session-wide uniqueness on `agent.start` `name`. A hardcoded name works
once and collides on the second run.

Before:

```yaml
version: v1alpha1
title: Start a worker agent
description: start an agent in the invoking pane
steps:
  - herdr: agent.start
    params:
      pane_id: "{{context.pane}}"
      kind: claude
      name: worker
```

After — derive the name from the target pane id in a prior `run:` step:

```yaml
version: v1alpha1
title: Start a worker agent
description: start an agent in the invoking pane, named per pane so repeat runs do not collide
steps:
  - id: agent_name
    env:
      PANE: "{{context.pane}}"
    run: |
      set -eu
      printf %s "claude-$(printf %s "$PANE" | tr -c 'A-Za-z0-9' '-')"
  - herdr: agent.start
    params:
      pane_id: "{{context.pane}}"
      kind: claude
      name: "{{steps.agent_name.stdout}}"
```

Keep any existing prefix the workflow used (`worker-` here would stay `worker-`) — the fix is
the per-pane suffix, not a rename. Reference the derived name as `{{steps.<id>.stdout}}`: there
is no `output` field and no bracket indexing, and any other `{{…}}` shape fails to load.

## 3. `herdr … | jq` pipelines swallow herdr failures

A pipeline's exit status is the last command's, and jq exits 0 even on empty input, so
`herdr worktree list --json | jq …` succeeds when herdr itself failed. `set -e` does not help —
the failing herdr is not the last command in the pipe.

Before:

```yaml
version: v1alpha1
title: List worktree branches
description: print the worktree branches herdr reports
steps:
  - run: |
      herdr worktree list --cwd . --json | jq -r '.result.worktrees[]?.branch'
```

After — capture first, then pipe the variable:

```yaml
version: v1alpha1
title: List worktree branches
description: print the worktree branches herdr reports
steps:
  - run: |
      set -eu
      list=$(herdr worktree list --cwd . --json)
      printf %s "$list" | jq -r '.result.worktrees[]?.branch'
```

The same applies to any `herdr … | jq` inside an input's `options: {run:}` discovery command:
capture into a variable there as well, or a herdr failure reads as "no options" instead of an
error.
