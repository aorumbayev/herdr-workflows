# Examples

Each card on this page copies a `hwf workflow import "<base64>"` command. Import prints the full YAML, marks commands, transcript access, and sensitive Herdr methods, asks for confirmation, then writes into repo or global `.hwf/workflows`.

All shipped examples use `version: v1alpha1`.

## Review

Capture `git diff HEAD`, then open a managed Claude pane when the diff is non-empty.

```yaml
version: v1alpha1
title: Review
description: Review the working tree diff, skipping the agent when it is clean
steps:
  - id: diff
    run: [git, diff, HEAD]

  - agent: |
      Review this diff. List blocking issues only.

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    timeout: 15m
    pane:
      open: beside
```

## Worktree

Create and focus a git worktree through an explicit Herdr call.

```yaml
version: v1alpha1
title: Worktree
description: Create a worktree and focus it
inputs:
  branch: text
  base:
    type: choice
    options: [main, develop]
    default: main
steps:
  - herdr: worktree.create
    params:
      workspace_id: "{{context.workspace}}"
      branch: "{{inputs.branch}}"
      base: "{{inputs.base}}"
      label: "{{inputs.branch}}"
      focus: true
```

## Handoff

Entry workflow collects a profile and optional focus text, then runs a hidden child that distils `{{context.transcript}}` on the invoking agent (`target:`) and opens the destination profile in a new tab.

Transcript access is intentional reviewed YAML. Import flags that reference before you confirm.

## Prompt enhance

Entry workflow collects a profile and prompt text, then a hidden child rewrites the text in a managed pane, copies the managed `response` to the clipboard (`pbcopy` / `xclip` by platform), and notifies.

## Authoring tips

- Prefer argv-form `run: [cmd, arg]` for values that must be arguments.
- Use `{{steps.id.response}}` / `{{steps.id.stdout}}` — results are automatic.
- Background work needs a Herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow's `on_failure:` only.
