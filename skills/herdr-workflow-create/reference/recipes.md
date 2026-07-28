# Recipes (v1alpha1)

## Review gate

```yaml
version: v1alpha1
title: Review
steps:
  - id: diff
    run: [git, diff, HEAD]
  - agent: |
      Review this diff. Blocking issues only.

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    pane: { open: beside }
```

## Worktree

```yaml
version: v1alpha1
inputs:
  branch: text
steps:
  - herdr: worktree.create
    params:
      workspace_id: "{{context.workspace}}"
      branch: "{{inputs.branch}}"
      focus: true
```

## Notify on failure

```yaml
version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.workflow}}"
    body: "{{context.error.message}}"
    sound: request
steps:
  - run: [bun, test]
```

## Child composition

```yaml
# parent.yaml
version: v1alpha1
inputs:
  branch: text
steps:
  - workflow: child
    inputs:
      branch: "{{inputs.branch}}"
```

```yaml
# child.yaml
version: v1alpha1
inputs:
  branch: text
returns:
  ok: "{{steps.check.exit_code}}"
steps:
  - id: check
    run: [git, rev-parse, "--verify", "{{inputs.branch}}"]
```

## Platform fork

```yaml
version: v1alpha1
steps:
  - run: [pbcopy]
    when: '{{context.platform}} == "macos"'
  - run: [xclip, -selection, clipboard]
    when: '{{context.platform}} == "linux"'
```

## Existing-agent target

Requires an already-running agent that is idle or done. A busy invoking pane fails preflight —
warn the user before saving this pattern.

```yaml
version: v1alpha1
steps:
  - agent: |
      Continue from here.
    target: "{{context.agent}}"
```

## Background placed run

Fire-and-forget in a Herdr-owned pane. Do not combine with `ready_when`.

```yaml
version: v1alpha1
steps:
  - run: [bun, run, long-job]
    pane: { open: tab }
    background: true
```

## Readiness-gated placed run

Block until pane output matches. Requires `timeout`. Do not combine with `background`.

```yaml
version: v1alpha1
steps:
  - run: [lazygit]
    pane: { open: tab }
    ready_when: "/lazy.?git/"
    timeout: 30s
```
