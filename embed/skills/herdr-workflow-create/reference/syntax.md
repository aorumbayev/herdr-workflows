# Workflow syntax (v1alpha1)

## Document

```yaml
version: v1alpha1 # required — a file without it does not load
title: optional picker title
description: optional picker subtitle
hidden: true # optional; hide from picker
# inputs: optional
# returns: optional — a non-empty map of templates, or one whole-value template
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
    description: Branch to compare against
    options:
      run: [git, branch, --format=%(refname:short)]
    default: main
```

Input **names** match `[a-z][a-z0-9_]{0,31}` — same rule as step ids, hyphens rejected.

Mapped-input keys — these seven and no others: `type`, `description`, `default`, `options`,
`when`, `allow_custom`, `min_length`. Any other key fails to load.

`description:` is the only part of the picker's prompt line an author controls — **write one for
every non-shorthand input**.

Types: `text`, `choice` (static list or `{run: argv}`), `profile`. Only the entry workflow prompts.
A closed choice's `default:` must be one of its `options:`. Dynamic-choice argv runs from the
project root, receives no partially collected `HWF_*` inputs, and should only do read-only
discovery.

Dynamic-choice argv elements may carry `{{inputs.<name>}}` templates that name **earlier** declared
inputs, substituted right before the command runs. `steps.*` and `context.*` roots fail to load, and
so do a self reference and a forward reference. Referencing a guarded input requires the consuming
input's `when:` to repeat every clause guarding it. Changing an earlier answer discards the later
answers and the options resolved from them.

```yaml
inputs:
  repo:
    type: choice
    description: Repository to inspect
    options: { run: [ls, repos] }
  branch:
    type: choice
    description: Branch in that repository
    options: { run: [git, -C, "repos/{{inputs.repo}}", branch, --format=%(refname:short)] }
```

## Actions

Exactly one of `agent`, `run`, `herdr`, `workflow`.

Optional `id:` on any step — **must match `[a-z][a-z0-9_]{0,31}`**: lowercase, first character a
letter, underscores only. `id: run-tests` fails to load — use `run_tests`. Only a step with an `id:`
can be referenced by `{{steps.<id>.…}}`.

### `run:`

- argv list — local and tab placement avoid a shell. Split placement submits one shell-quoted line. Each element accepts templates
- string — shell (`sh` by default, override with `shell:`). No templates in the command text. Use
  `env:` / `HWF_*`

Blocking local result: `{stdout, stderr, exit_code, failed}`. A readiness run returns native wait data plus pane, tab, and workspace IDs. A background run has no result.

### `agent:`

```yaml
- agent: |
    Review {{context.selection}}
  using: claude
  pane: { open: beside, size: 40, close: success }
```

or `target: "{{context.agent}}"` for an existing **idle/done** agent — it rejects `pane:`, `cwd:`,
`env:` and `using:`, because that agent already has a pane. A busy target fails before the prompt
is sent.

Blocking result: `{response, agent, pane_id}`, plus `verdict` when the step declares `expect:`.

```yaml
- id: review
  agent: Review this. Findings first, verdict on the final line.
  using: claude
  expect:
    one_of: [APPROVE, REJECT] # distinct tokens matching [A-Z][A-Z0-9_]{0,31}
    require: [APPROVE] # optional non-empty subset that lets the step succeed
```

`verdict` is the final non-empty line of the response, trimmed and matched exactly, so reasoning
above it is fine. The runner appends the token list, the final-line rule, and an
`hwf response check <file> --one-of TOKEN,TOKEN` command to the prompt — the same parse the runner
applies at settle time, which the agent reruns against its own response file until it exits 0. An
unmatched final line or a verdict outside `require` is an ordinary step failure that names the
tokens. `expect:` fails to load with `background: true` or on any other action, and
`{{steps.<id>.verdict}}` fails to load when the producer declares no `expect:`.

### `herdr:`

Raw `herdr:` calls never autofill targets from live UI focus, and every method's required selector
is listed in **reference/herdr-api.md** — read that table rather than guessing. A template on an
unrelated param does not waive the requirement, and a method not on the allowlist fails at load.

```yaml
- herdr: worktree.create
  params:
    workspace_id: "{{context.workspace}}" # exactly one of workspace_id | cwd — never both
    branch: "{{inputs.branch}}"
    focus: true
```

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

The child is resolved from `.hwf/workflows/` relative to the current directory, so validate from
the project root. The child's `returns:` becomes this step's result. Referencing a result of a
child that declares no `returns:` fails to load.

## Templates

`{{inputs.*}}`, `{{steps.<id>.*}}`, `{{context.*}}` only.

Context keys: `workspace`, `tab`, `pane`, `worktree`, `cwd`, `agent`, `selection`, `platform`,
`transcript`, `transcript_file`, and recovery-only `error` (`error.message`, `error.workflow`,
`error.action`, `error.step_number`, `error.workflow_path`, `error.details`, optional `error.step_id`).

## Pane / background / readiness

```yaml
pane:
  open: tab | beside | below # or "{{inputs.place}}" for a closed static choice of those literals
  size: 40 # beside/below only — percent for the NEW pane; a tab has no size
  target: "…" # beside/below only — pane to split
  workspace: "…" # tab only
  focus: true
  close: success # agent-only
```

A `run:` step with `pane:` must set **exactly one** of:

```yaml
background: true # fire-and-forget; rejects timeout:, retry: and pane.close
```

or

```yaml
ready_when: "/ready/" # /regex/ with NO flags; requires timeout; recent 80 rows, ANSI stripped
timeout: 30s
```

Neither, or both, fails to load.

## Control flow

- `when:` one clause or ordered list (AND): scalar truthiness or `==` / `!=`. It rejects structured
  sources — reference a scalar field such as `{{steps.x.stdout}}`, not `{{steps.x}}`
- Mapped inputs may declare `when:` (earlier inputs only). Inactive inputs are skipped
- Conditional input refs (templates or shell `$HWF_<name>`) need matching step `when:` guards
- `allow_custom: true` on choices only, `min_length` on mapped inputs, `success_codes` on blocking
  local `run:` only
- `pane.open` may be `{{inputs.place}}` when `place` is an unconditional closed static choice of
  `tab`/`beside`/`below`
- `continue_on_error: true`
- `retry: { attempts: 2, delay: 1s }` — blocking local `run:` / `herdr:` only
- entry `on_failure:` once

## Caps

16 KiB per managed agent prompt — a longer prompt is written to a run-owned file and the agent is
told to read that path instead, so keep prompts small if the agent must see them inline.
24 KiB `HWF_*` env (entry and child). 8 MiB per capture. 1,000 dynamic choices / 10s.
30s transcript extractors.
