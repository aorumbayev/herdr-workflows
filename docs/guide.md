# Write a workflow

A workflow is a YAML file with a list of steps. The steps run in order, top to bottom. There are no loops and no parallel groups. A step can skip with `when:`. For anything richer, write a shell script and call it from a `run:` step.

This page covers the parts you write. [Reference](/reference) lists every field and limit.

## The smallest workflow

```yaml
# .hwf/workflows/tests.yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

Save it in `.hwf/workflows/` for this repo, or `~/.hwf/workflows/` for every repo. Workflow names must match `[a-z0-9][a-z0-9-_]*`. Use `<name>.yaml`. `hwf` does not discover `.yml` files. If both scopes have a `tests.yaml`, the repo one wins.

Run it with `prefix+k` or `hwf run tests`.

Every file needs `version: v1alpha1`. That's the workflow format version, not the plugin version, and the two move independently.

## Name it for the picker

```yaml
version: v1alpha1
title: Run tests
description: Runs the unit suite and reports failures
hidden: false
steps:
  - run: [bun, test]
```

`title` shows in the picker list, and defaults to the file name in title case. `description` shows below the list when the workflow is selected. `hidden: true` keeps a workflow out of the picker while `hwf run` still works, which is what you want for children other workflows call.

## The four kinds of step

Each step does exactly one of these four things. Mixing two in one step is an error.

### Run a command

```yaml
steps:
  - id: diff
    run: [git, diff, HEAD] # list form: argv
  - run: bun test | tee out.log # string form: runs through sh
```

Use the **list form** by default. Each item is one argument, so a branch name with spaces stays one argument and nothing gets word-split. Templates work in list items. Local list-form commands and `pane.open: tab` run without a shell. `beside` and `below` submit one shell-quoted line to the new pane.

Use the **string form** only when you need shell features like pipes or redirects. The string form rejects templates on purpose, so a value can't be spliced into shell source. Pass values through `env:` instead:

```yaml
- run: git log --oneline "$BASE"..HEAD | head -20
  env:
    BASE: "{{inputs.base}}"
```

A blocking local command gives you `stdout`, `stderr`, `exit_code`, and `failed`. A readiness run returns native wait data plus pane, tab, and workspace IDs. A background command has no result.

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

`using:` names a profile from your config and starts a fresh agent for this step. `target:` addresses an agent that's already running, by name or pane ID. Use one or the other, never both.

The step waits for the turn to finish and gives you `response`, `agent`, and `pane_id`. A turn waits 30 minutes by default. Starting the agent gets its own 30-second budget.

A `target:` step needs that agent to be idle or done before it prompts. It fails otherwise, because herdr can't tell one queued turn from another. That also means a workflow can't prompt the agent that started it — the agent you asked to run the workflow is busy with that request.

### Call herdr

```yaml
- herdr: notification.show
  params:
    title: tests passed
    sound: done
```

`herdr:` calls one method on the herdr socket API, and `params:` is that method's exact request. You get the method's full result back.

Nothing is filled in for you. If a method needs to know which pane or tab to act on, say so:

```yaml
- herdr: tab.rename
  params:
    tab_id: "{{context.tab}}"
    label: review
```

That's deliberate. An omitted target would otherwise fall through to whatever pane happens to have focus, which is a different pane by the time the step runs.

Methods that could stop the server, rewrite plugin state, or take over agent identity are refused when the file loads. See [the denied list](/reference#trust-and-sharing).

### Call another workflow

```yaml
- id: checks
  workflow: run-checks
  inputs:
    branch: "{{inputs.branch}}"
```

The child gets its own inputs and its own step results, and can't see yours. To send a value back, the child declares `returns:`:

```yaml
# run-checks.yaml
returns:
  summary: "{{steps.report.stdout}}"
```

The parent then reads `{{steps.checks.summary}}`. A child with no `returns:` has no result, and referencing one is a load error.

## Pass values between steps

Give a step an `id`, then read its result. There's no output binding to declare — results attach on their own.

```yaml
steps:
  - id: branch
    run: [git, branch, --show-current]
  - herdr: notification.show
    params:
      title: "on {{steps.branch.stdout}}"
```

Templates read from exactly three places:

| Template             | Holds                                  |
| -------------------- | -------------------------------------- |
| `{{inputs.name}}`    | An answer the person running gave you  |
| `{{steps.id.field}}` | An earlier step's result               |
| `{{context.key}}`    | Where and how the workflow was started |

A template that fills a whole YAML value keeps that value's type, so an object stays an object. A template inside a longer string renders as text. Anything else — a typo in a path, a forward reference, a reference to a background step that produces no result — fails when the file loads, not halfway through your run.

Useful context keys: `pane`, `tab`, `workspace`, `worktree`, `cwd`, `agent`, `selection`, `platform`. See [Reference](/reference#context) for all of them.

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

The picker asks for these in order, before step 1. Only the workflow you started asks. Children take their values from the parent.

- **`type: text`** takes any text. **`type: choice`** offers a list. **`type: profile`** offers your profile names.
- **Options can be a command.** `{run: [...]}` runs from your repo root and turns each output line into an option.
- **`allow_custom: true`** turns the options into suggestions and accepts anything else typed.
- **`min_length`** rejects a value that's too short. Use `min_length: 1` to refuse an empty answer.
- **`when:`** hides an input based on an earlier answer. The example never asks for a branch in `status` mode, and doesn't run the branch-listing command either.

Write a `description` for every input. It's the only part of the prompt you control.

Inputs also reach `run:` steps as environment variables named `HWF_<name>`.

Check what a workflow will ask before you run it:

```bash
hwf workflow inspect branch-check
hwf workflow inspect branch-check --input mode=branch --resolve
```

Without `--resolve`, a dynamic option command is printed instead of run.

## Put steps somewhere you can see

`run:` and `agent:` steps take a `pane:` block. Without one, an agent gets a new tab and a command runs unseen while the workflow waits for it.

```yaml
- run: [npm, run, dev]
  pane:
    open: beside # tab | beside | below
    size: 40 # percent of the anchor for the new pane, 1-99
    focus: true
  ready_when: /listening on/
  timeout: 30s
```

- **`open: beside` or `below`** splits the pane you started from. **`open: tab`** makes a new tab in the workspace you started from. Placement uses the IDs captured at the start, so moving your focus mid-run changes nothing.
- **A placed command needs to say when it's ready.** Use `ready_when: /regex/` with a `timeout`, which watches the pane's recent output for that pattern, or `background: true` for something you never wait on. The two are mutually exclusive.
- **`ready_when` watches text, not exit codes.** It succeeds when the pattern shows up and fails when the timeout passes. It can't tell you the process died.
- **Background processes belong to their pane.** They survive you detaching your client. They don't survive a server restart, and a later failure elsewhere in the workflow won't stop them.
- **Agents can clean up after themselves** with `close: success` or `close: always`. `close` doesn't apply to commands.

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
    continue_on_error: true # a failure here doesn't stop the run

on_failure:
  herdr: notification.show
  params:
    title: "review failed: {{context.error.message}}"
```

- **`when:`** takes one condition or an ordered list of them, joined by AND and evaluated left to right. A condition is either a template read for truthiness or a comparison with `==` or `!=` against a quoted string. Empty string, `0`, `false`, and null are false. There's no OR, no parentheses, and no expressions. A false condition marks the step skipped and moves on.
- **`success_codes:`** lists the exit codes you count as success. Probes that report a fact through their exit code, like `git diff --quiet`, need this.
- **`continue_on_error: true`** records the failure, keeps going, and does not trigger `on_failure` for that tolerated failure. A later non-tolerated failure can still trigger entry recovery. The run still exits nonzero at the end.
- **`retry:`** takes `attempts` (2 or more, counting the first) and an optional `delay`. Commands and `herdr:` calls only, never agents.
- **`on_failure:`** runs one action, once, after the first real failure anywhere in the run, including inside a child. Only the workflow you started gets to recover. `{{context.error}}` tells it what broke: message, workflow, action, step number, and details. The run still counts as failed.

If the connection to herdr drops mid-step, the run stops, keeps your panes, and skips `on_failure`. It won't retry, because it can't tell whether the step you dispatched finished.

## Hand your session to an agent

`{{context.transcript}}` and `{{context.transcript_file}}` carry your current session's transcript into a prompt. The [Handoff example](/examples) uses it to brief a fresh agent on everything you've been doing. This is the most sensitive thing a workflow can read, and every review surface marks it.

### Where the transcript comes from

It's read once, before step 1, from the pane you launched the workflow from, never from an agent the workflow starts. So the agent that matters is the one you're sitting in, not the one in `using:`. If that read fails, the run stops there and no step executes.

Extraction is built in for one kind: `claude`. It needs herdr's Claude integration installed, because that's what reports the session id:

```bash
herdr integration install claude
```

With that in place, hwf reads the session's `.jsonl` under `~/.claude/projects/` and keeps the user and assistant text, dropping tool traffic.

Every other kind, including codex, opencode, and cursor, needs an extractor, or the run fails preflight.

### Support another agent kind

An extractor is any command that prints a transcript to stdout, keyed by herdr's agent kind:

```yaml
# .hwf/config.yaml
transcripts:
  codex:
    command: [my-transcript-tool, --stdout]
```

hwf runs it in the agent's working directory with these set:

| Variable                       | What it holds                                  |
| ------------------------------ | ---------------------------------------------- |
| `HWF_TRANSCRIPT_PANE_ID`       | The pane the workflow was launched from        |
| `HWF_TRANSCRIPT_AGENT_KIND`    | The kind herdr detected there                  |
| `HWF_TRANSCRIPT_CWD`           | That agent's cwd, or the invocation cwd        |
| `HWF_TRANSCRIPT_SESSION_KIND`  | Session reference type, when herdr reports one |
| `HWF_TRANSCRIPT_SESSION_VALUE` | Session id or path, when herdr reports one     |

It has to exit 0, print something, finish inside 30 seconds, and produce at most 8 MiB. An entry replaces built-in extraction for that kind, so you can override `claude` too.

### Transcript limitations

- One transcript per run, taken before the first step. Nothing refreshes it mid-run.
- Only the invoking pane. There's no way to read some other agent's history.
- That pane has to have an agent in it. Launch from a plain shell and there's nothing to extract.
- `claude` is the only kind supported out of the box, and only with its herdr integration installed. Everything else is on you to write.
- Failure is total, never partial: no extractor, an empty result, a timeout, or an oversized transcript all stop the run before step 1 rather than handing an agent half a session.

## Build with an agent instead

The `herdr-workflow-create` skill interviews you, writes the YAML, keeps the workbench canvas in sync, and validates the file with this plugin's own loader before saving:

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Next

- [Run and manage workflows](/surfaces) — picker, CLI, workbench, sharing
- [Examples](/examples) — working workflows to import
- [Reference](/reference) — every field, limit, and rule
