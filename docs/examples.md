# Examples

Copy into `.hwf/workflows/<name>.yaml` (repo) or `~/.hwf/workflows/<name>.yaml` (global, every project). Ordered simple → complex.

## Scratch — open a tool

```yaml
# scratch.yaml
steps:
  - run: lazygit
    in: tab
```

`prefix+k` → `scratch` → enter.

## Continue — hand the current pane to an agent

`{pane}` is the visible text of the pane you launched from; `{prompt}` is the line the picker asks for.

```yaml
# continue.yaml
steps:
  - agent: claude
    prompt: |
      Continue from this pane:

      {pane}

      Focus: {prompt}
```

## Gate & ship — compose, recover on failure

```yaml
# gate.yaml
inputs:
  suite: [unit, all] = unit
steps:
  - run: [bun, test, "--", "{suite}"]
  - run: bun run verify
```

```yaml
# ship.yaml
on_error: continue
steps:
  - use: gate
    with: { suite: all }
  - run: git push
```

## Inputs — ask the user

```yaml
# discuss.yaml
inputs:
  branch: sh git branch --format='%(refname:short)'
  focus: text = ""
steps:
  - agent: claude
    prompt: "Branch {branch}\nFocus: {focus}\n\n{pane}"
```

CLI: `hwf run discuss --input branch=main`.

## Guarded review

Seeded by `hwf init`. Skips the agent when the tree is clean:

```yaml
# review.yaml
steps:
  - run: git diff HEAD
    out: diff
  - agent: claude
    when: "{diff}"
    timeout: 900
    prompt: |
      Review this diff. List blocking issues only.

      {diff}
```

## Worktree — primitive

```yaml
# worktree.yaml
inputs:
  branch: text
  base: [main, develop] = main
steps:
  - worktree.create: { branch: "{branch}", base: "{base}", label: "{branch}", focus: true }
    out: { path: worktree.path }
```

## Handoff — session into a prompt

Run from an agent pane. Distils `{session}` with `{agent}`, opens the target, closes the source tab:

```yaml
# handoff.yaml
inputs:
  target: agents
  focus: text = ""
steps:
  - agent: "{agent}"
    timeout: 900
    out: brief
    prompt: |
      Distil the transcript below into a handoff prompt.
      Output ONLY the handoff prompt.
      ---
      {session}
  - agent: "{target}"
    prompt: |
      Focus: {focus}

      {brief}
  - tab.close: { tab_id: "{source_tab}" }
```

## Fix-until-green

```yaml
steps:
  - run: bun test
    out: failures
    retry:
      times: 3
      until: bun test
      reset: git stash
  - agent: claude
    when: "{failures}"
    prompt: "Tests failed:\n{failures}"
```

## Per-file review loop

```yaml
steps:
  - run: git diff --name-only main
    out: changed
  - agent: claude
    for: "{changed}"
    as: path
    allow_fail: true
    prompt: "Review {path}. Blocking issues only."
```

## Dedicated review workspace

```yaml
inputs:
  branch: text = main
steps:
  - workspace.create: { label: "review {branch}" }
    out: { workspace: workspace.workspace_id }
  - run: [git, diff, "{branch}"]
    in: tab
  - agent: claude
    in: right
    ratio: 0.4
    prompt: "Review the diff in the pane on the left."
```
