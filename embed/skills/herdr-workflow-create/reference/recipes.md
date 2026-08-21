# Recipes (v1alpha1)

## Review gate

`expect:` makes the verdict a token, so the gate compares one word instead of the whole response.
A consumer of a guarded step repeats that step's `when:` clauses first.

```yaml
version: v1alpha1
title: Review
steps:
  - id: diff
    run: [git, diff, HEAD]
  - id: review
    agent: |
      Review this diff. Blocking issues only. Findings first, verdict on the final line.

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    pane: { open: beside }
    expect:
      one_of: [APPROVE, REJECT]
  - run: [sh, -c, 'printf "%s\n" "$FINDINGS" >&2; exit 1']
    env:
      FINDINGS: "{{steps.review.response}}"
    when:
      - "{{steps.diff.stdout}}"
      - '{{steps.review.verdict}} == "REJECT"'
```

Use `require: [APPROVE]` instead of the gated `run:` when any other token should fail the step
outright.

## Worktree

```yaml
version: v1alpha1
inputs:
  branch:
    type: text
    description: Branch the new worktree checks out
steps:
  - herdr: worktree.create
    params:
      # exactly one of workspace_id | cwd — passing both fails to load
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
  - run: [make, test]
```

## Child composition

```yaml
# parent.yaml
# validate from the project root so `child` resolves
version: v1alpha1
inputs:
  branch:
    type: text
    description: Branch the child verifies
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
  - run: [make, long-job]
    pane: { open: tab } # a tab takes no `size:`; use open: beside to size a split
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

## Sized split, fire-and-forget

`size:` is only legal with `open: beside`/`below`. "Give it 40% of the screen" means a split.

```yaml
version: v1alpha1
steps:
  - run: [make, dev]
    pane: { open: beside, size: 40 }
    background: true
```

## Guarded input

An input with `when:` only prompts when the guard holds, and every step referencing it needs the
same guard. Step ids are `[a-z][a-z0-9_]{0,31}` — no hyphens.

```yaml
version: v1alpha1
inputs:
  deep:
    type: choice
    description: Run the deeper review pass?
    options: [yes, no]
    default: "no"
  scope:
    type: text
    description: Area the deep pass should focus on
    when: '{{inputs.deep}} == "yes"'
steps:
  - id: git_diff
    run: [git, diff, HEAD]
  - id: deep_lint
    run: [make, lint, "SCOPE={{inputs.scope}}"]
    when: '{{inputs.deep}} == "yes"'
```

## Capture before jq

A pipeline reports only the last command's exit status, and `jq` exits 0 on empty input, so
`herdr … | jq` hides a herdr failure behind empty output. Capture the output into a variable
first, in `run:` steps and in dynamic-choice option commands: a herdr failure then aborts the
command and its stderr reaches the user.

```yaml
version: v1alpha1
inputs:
  worktree:
    type: choice
    description: Which existing worktree
    options:
      run:
        [
          sh,
          -c,
          'set -eu; list=$(herdr worktree list --cwd . --json); printf %s "$list" | jq -r ''.result.worktrees[]? | select(.is_linked_worktree) | .branch''',
        ]
steps:
  - run: [echo, "{{inputs.worktree}}"]
```
