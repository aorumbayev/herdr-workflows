# Write a workflow

A workflow is a YAML file with a list of steps that run in order. There are no loops and no parallel groups. A step can skip with `when:`. For more logic, call a shell script from a `run:` step. This page teaches by example. The [Reference](/reference) is the home of every rule.

## The smallest workflow

```yaml
# .hwf/workflows/tests.yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

Save the file in `.hwf/workflows/` for this repo, or in `~/.hwf/workflows/` for every repo. Run it with `prefix+k` or with `hwf run tests`. [Document](/reference#document) gives the file rules.

## Name it for the picker

```yaml
version: v1alpha1
title: Run tests
description: Runs the unit suite and reports failures
hidden: false
steps:
  - run: [bun, test]
```

`hidden: true` removes a workflow from the picker, but `hwf run` still works. Use it for children that other workflows call.

## The four kinds of step

Each step does exactly one of four things.

### Run a command

```yaml
steps:
  - id: diff
    run: [git, diff, HEAD] # list form: argv
  - run: bun test | tee out.log # string form: runs through sh
```

Use the **list form** by default. Each item is one argument, and templates work in items. The **string form** gives you shell features but rejects templates, so pass values through `env:`:

```yaml
- run: git log --oneline "$BASE"..HEAD | head -20
  env:
    BASE: "{{inputs.base}}"
```

A blocking command gives you `stdout`, `stderr`, `exit_code`, and `failed`. [`run:`](/reference#run) lists every field.

### Prompt an agent

```yaml
- id: review
  agent: |
    Review this diff. Blocking issues only.

    {{steps.diff.stdout}}
  using: deep-review
  pane:
    open: beside
```

`using:` names a profile and starts a new agent. `target:` prompts an agent that is already active and idle. The step waits for the turn and gives you `response`, `agent`, and `pane_id`. A turn waits 30 minutes by default, and the agent has 30 seconds to start.

To turn the answer into one token you can compare, add `expect:`:

```yaml
  expect:
    one_of: [APPROVE, REJECT]
```

A later step reads `{{steps.review.verdict}}`. [`agent:`](/reference#agent) and [`expect:`](/reference#expect) give the rules.

### Call herdr

```yaml
- herdr: notification.show
  params:
    title: tests passed
    sound: done
```

`herdr:` calls one herdr API method, and `params:` is the exact request. hwf never fills a target for you, so pass `tab_id: "{{context.tab}}"` yourself. An omitted target would go to the pane that has focus, and that is a different pane when the step runs. [`herdr:`](/reference#herdr) lists the required selectors and the denied methods.

### Call another workflow

```yaml
- id: checks
  workflow: run-checks
  inputs:
    branch: "{{inputs.branch}}"
```

The child cannot read your inputs or results. It declares `returns:` to give a value back:

```yaml
# run-checks.yaml
returns:
  summary: "{{steps.report.stdout}}"
```

The parent reads `{{steps.checks.summary}}`. [`workflow:`](/reference#workflow) gives the rules.

## Pass values between steps

Give a step an `id`, then read its result with `{{steps.id.field}}`. The other roots are `{{inputs.name}}` and `{{context.key}}`.

```yaml
steps:
  - id: branch
    run: [git, branch, --show-current]
  - herdr: notification.show
    params:
      title: "on {{steps.branch.stdout}}"
```

A whole-value template keeps its type, and an embedded one renders as text. A typo or a forward reference fails at load. [Templates](/reference#templates) lists every key.

## Use the scratch store

Scratch is a flat key-value store for small values that outlive a run. There is no `{{scratch.*}}` template. A step runs `hwf scratch get` and reads `{{steps.*.stdout}}`:

```yaml
steps:
  - id: pr
    run: [gh, pr, view, --json, number, --jq, .number]
  - run: [hwf, scratch, set, triage.last_pr, "{{steps.pr.stdout}}"]
  - id: load
    run: [hwf, scratch, get, triage.last_pr]
  - agent: The last PR number is {{steps.load.stdout}}.
    using: claude
```

hwf deletes a key that starts with `${HWF_RUN_ID}.` when that run expires. [Scratch](/reference#scratch) lists the commands and limits.

## Ask questions before the run

```yaml
inputs:
  mode:
    type: choice
    description: What to check
    options: [status, branch]
    default: status
  branch:
    type: choice
    description: Branch to look for
    options: { run: [git, branch, --format=%(refname:short)] }
    allow_custom: true
    min_length: 1
    when: '{{inputs.mode}} == "branch"'
```

The picker prompts for these in order, before step 1. `options` can be a command, and that command can read an earlier answer through `{{inputs.<name>}}`. `allow_custom` adds a `custom...` row that opens a text field, and the field starts from your filter text. `when:` removes an input, and in `status` mode the branch command never runs. Inputs also reach `run:` steps as `HWF_<name>` variables. Preview the prompts with `hwf workflow inspect <name> --resolve`. [Inputs](/reference#inputs) gives the guard and cascade rules.

## Put steps somewhere you can see

`run:` and `agent:` steps take a `pane:` block. Without one, an agent opens in a new tab, and a command runs unseen.

```yaml
- run: [npm, run, dev]
  pane:
    open: beside # tab | beside | below
    size: 40 # percent for the new pane, 1-99
    focus: true
  ready_when: /listening on/
  timeout: 30s
```

`beside` and `below` split the pane you started from, and `tab` makes a new tab. A placed command has exactly one of `ready_when: /regex/` with a `timeout`, or `background: true`. Agents can close their own pane with `close:`. [`pane:`](/reference#pane) and [Background and readiness](/reference#background-and-readiness) give every rule.

## Skip, tolerate, and recover

```yaml
steps:
  - id: diff
    run: [git, diff, --quiet]
    success_codes: [0, 1] # 1 means "changes found", not failure

  - agent: Review the changes.
    using: claude
    when: '{{steps.diff.exit_code}} != "0"' # skipped when the tree is clean

  - herdr: notification.show
    params: { title: cleanup ran }
    continue_on_error: true # a failure here does not stop the run

on_failure:
  herdr: notification.show
  params:
    title: "review failed: {{context.error.message}}"
```

`when:` takes one condition or an ordered list joined by AND. `success_codes` lists the exit codes that count as success. `continue_on_error` records a failure and continues. `retry:` repeats commands and `herdr:` calls, never agents. `on_failure:` runs one action after the first real failure, and the run still counts as failed. [Control flow](/reference#control-flow) gives the truthiness and recovery rules.

## Hand your session to an agent

`{{context.transcript}}` and `{{context.transcript_file}}` carry your session transcript into a prompt. The [Handoff example](/examples) uses it to brief a new agent. This is the most sensitive value a workflow can read. hwf reads it once, before step 1, from the pane you launched from, never from an agent the workflow starts. The agent that matters is the one you sit in, not the one in `using:`. hwf has built-in extraction for `claude`, and it needs `herdr integration install claude`. Every other kind needs an extractor.

### Support another agent kind

An extractor is any command that prints a transcript to stdout, keyed by the herdr agent kind:

```yaml
# .hwf/config.yaml
transcripts:
  codex:
    command: [my-transcript-tool, --stdout]
```

An entry replaces the built-in extraction for that kind. [Config](/reference#config) gives the environment variables and the limits.

## Build with an agent

Two skills ship inside the CLI. `herdr-workflow-create` interviews you, writes the YAML, and validates it. `herdr-workflow-upgrade` updates the workflows of a repo to a newer herdr.

```bash
hwf skills list
hwf skills show herdr-workflow-create
```

Or paste this to your agent:

```
Set up the herdr-workflows toolkit so you can build workflows for me:

1. If `hwf` is not on PATH: herdr plugin install aorumbayev/herdr-workflows
2. Read the bundled authoring skill with `hwf skills show herdr-workflow-create` and follow
   the authoring workflow it describes.
3. In this repo: run `hwf init` if .hwf/config.yaml is missing, then validate drafts with
   `hwf workflow validate` (or the skill `scripts/validate.sh`).
4. Build a small test workflow — one `run: [git, status, --short]` step — save it under
   `.hwf/workflows/`, validate it, then interview me for the real one.
```

## Next

- [Run and manage](/surfaces) for the picker, the console, the CLI, and sharing
- [Examples](/examples) for workflows to import
- [Reference](/reference) for every field, limit, and rule
