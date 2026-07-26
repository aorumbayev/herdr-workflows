# Recipes

Ordered simple → complex. Every snippet passes the loader as written (agent names assume
`claude` is configured; `use:` targets assume those workflows exist). Adapt names, then
re-validate.

## Contents

- Open a tool
- Run a check
- Guarded review
- Ask the user for inputs
- Fix until green
- Per-file loop
- Worktree
- Review workspace
- Session handoff
- Compose with `use:`
- Recover and notify
- Detached process

## Open a tool

```yaml
desc: lazygit in a new tab
steps:
  - run: lazygit
    in: tab
```

## Run a check

```yaml
steps: bun test
```

Multiple commands, one shell, fail fast:

```yaml
steps:
  - run: |
      set -eu
      bun install --frozen-lockfile
      bun test
    shell: bash
```

## Guarded review

Skips the agent when the tree is clean.

```yaml
desc: review uncommitted changes
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

## Ask the user for inputs

```yaml
desc: discuss a branch
inputs:
  branch: sh git branch --format='%(refname:short)'
  focus: text = ""
steps:
  - run: [git, log, "--oneline", "-20", "{branch}"]
    out: log
  - agent: claude
    prompt: |
      Branch {branch}
      Focus: {focus}

      {log}
```

CLI equivalent: `hwf run discuss --input branch=main --input focus=perf`.

## Fix until green

`reset:` is a shell command string, and is mandatory when the retried step creates a pane.

```yaml
steps:
  - run: bun test
    out: failures
    allow_fail: true
    retry:
      times: 3
      delay: 2
      until: bun test
      reset: git stash
  - agent: claude
    when: "{failures}"
    prompt: "Tests still failing:\n{failures}"
```

## Per-file loop

`{item}` / `{index}` bind per iteration and only inside the looping step; `as:` renames
`{item}`. Cap is 100 items.

```yaml
steps:
  - run: git diff --name-only main
    out: changed
  - agent: claude
    for: "{changed}"
    as: path
    allow_fail: true
    prompt: "Review {path} (#{index}). Blocking issues only."
```

## Worktree

```yaml
inputs:
  branch: text
  base: [main, develop] = main
steps:
  - worktree.create: { branch: "{branch}", base: "{base}", label: "{branch}", focus: true }
    out: { path: worktree.path }
  - agent: claude
    cwd: "{path}"
    prompt: "Start work on {branch}."
```

## Review workspace

Dedicated workspace, diff on the left, agent on the right.

```yaml
inputs:
  branch: text = main
steps:
  - workspace.create: { label: "review {branch}" }
    out: { ws: workspace.workspace_id }
  - run: [git, diff, "{branch}"]
    in: tab
    out: { p: pane_id }
  - agent: claude
    in: right
    ratio: 0.4
    prompt: "Review the diff in the pane on the left (pane {p})."
```

## Session handoff

Run from an agent pane: the invoking agent distils its own transcript, a target agent picks
it up, the source tab closes.

```yaml
inputs:
  target: agents
  focus: text = ""
steps:
  - agent: "{agent}"
    timeout: 900
    out: brief
    prompt: |
      Distil the transcript below into a handoff prompt for a fresh session.
      Output ONLY the handoff prompt.
      ---
      {session}
  - agent: "{target}"
    prompt: |
      Focus: {focus}

      {brief}
  - tab.close: { tab_id: "{source_tab}" }
```

## Compose with `use:`

```yaml
# gate.yaml
inputs:
  suite: [unit, all] = unit
steps:
  - run: [bun, test, "--", "{suite}"]
```

```yaml
# ship.yaml — on_error names another workflow, run once if a step fails
on_error: rollback
steps:
  - use: gate
    with: { suite: all }
  - run: git push
```

The `on_error:` target may not declare `inputs:` or its own `on_error:`. Child `out:`
names are visible to later steps in the parent.

## Recover and notify

Inline recovery on one step, with `{error}`:

```yaml
steps:
  - run: bun run deploy
    on_error:
      - notification.show: { title: "deploy failed", body: "{error}", sound: request }
```

## Detached process

A placed `run:` returns as soon as its pane exists, so a long-running command in a pane
never blocks the workflow. `wait: false` states that explicitly and cannot bind `out:`.

```yaml
steps:
  - run: bun run dev
    in: down
    ratio: 0.3
    wait: false
  - run: bunx wait-on http://localhost:3000
```

Wait on pane output instead of exiting (placed steps only):

```yaml
steps:
  - run: bun run dev
    in: tab
    wait: /ready in/
    timeout: 120
```
