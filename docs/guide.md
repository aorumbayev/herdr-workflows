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

Save it in `.hwf/workflows/` for this repo, or `~/.hwf/workflows/` for every repo. Workflow names must match `[a-z0-9][a-z0-9-_]*`. Use `<name>.yaml`. `hwf` does not discover `.yml` files. If both scopes have a `tests.yaml`, the repo one takes precedence.

Run it with `prefix+k` or `hwf run tests`.

Every file needs `version: v1alpha1`. That is the workflow format version, not the plugin version, and the two move independently.

## Name it for the picker

```yaml
version: v1alpha1
title: Run tests
description: Runs the unit suite and reports failures
hidden: false
steps:
  - run: [bun, test]
```

`title` shows in the picker list, and defaults to the file name in title case. `description` shows below the list when you select the workflow. `hidden: true` removes a workflow from the picker, but `hwf run` still works. That is what you want for children that other workflows call.

## The four kinds of step

Each step does exactly one of these four things. If you mix two in one step, that is an error.

### Run a command

```yaml
steps:
  - id: diff
    run: [git, diff, HEAD] # list form: argv
  - run: bun test | tee out.log # string form: runs through sh
```

Use the **list form** by default. Each item is one argument, so a branch name with spaces stays one argument and the shell does not split it into words. Templates work in list items. Local list-form commands and `pane.open: tab` run without a shell. `beside` and `below` submit one shell-quoted line to the new pane.

Use the **string form** only when you need shell features like pipes or redirects. The string form rejects templates on purpose, so you cannot splice a value into shell source. Pass values through `env:` instead:

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

`using:` names a profile from your config and starts a fresh agent for this step. `target:` addresses an agent that is already active, by name or pane ID. Use one or the other, never both.

The step waits for the turn to finish and gives you `response`, `agent`, and `pane_id`. A turn waits 30 minutes by default. The agent has 30 seconds to start.

A `target:` step needs that agent to be idle or done before it prompts. It fails otherwise, because herdr cannot find the difference between queued turns. That also means a workflow cannot prompt the agent that started it. The agent you asked to run the workflow is busy with that request.

### Call herdr

```yaml
- herdr: notification.show
  params:
    title: tests passed
    sound: done
```

`herdr:` calls one method on the herdr socket API, and `params:` is that method's exact request. You get the method's full result.

hwf adds nothing for you. If a method needs to know which pane or tab to use, name it:

```yaml
- herdr: tab.rename
  params:
    tab_id: "{{context.tab}}"
    label: review
```

That is deliberate. An omitted target would otherwise go to whatever pane has focus, which is a different pane by the time the step runs.

When the file loads, hwf rejects methods that could stop the server, rewrite plugin state, or take control of agent identity. Refer to [the denied list](/reference#trust-and-sharing).

### Call another workflow

```yaml
- id: checks
  workflow: run-checks
  inputs:
    branch: "{{inputs.branch}}"
```

The child gets its own inputs and its own step results, and cannot access yours. To return a value, the child declares `returns:`:

```yaml
# run-checks.yaml
returns:
  summary: "{{steps.report.stdout}}"
```

The parent then reads `{{steps.checks.summary}}`. A child with no `returns:` has no result, and a reference to one is a load error.

## Pass values between steps

Give a step an `id`, then read its result. There is no output binding to declare — results attach on their own.

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

A template that fills a whole YAML value keeps that value's type, so an object stays an object. A template inside a longer string renders as text. Anything else fails when the file loads, not halfway through your run. That includes a typo in a path, a forward reference, or a reference to a background step that produces no result.

Useful context keys: `pane`, `tab`, `workspace`, `worktree`, `cwd`, `agent`, `selection`, `platform`. Refer to [Reference](/reference#context) for all of them.

## Use the scratch store

Scratch is a flat key-value store in the same global history database as run history. Use it when a later run, or a later step, needs a small value that is not a step result.

There is no `{{scratch.*}}` template. A step that needs a scratch value runs `hwf scratch get` and then reads `{{steps.*.stdout}}`.

```yaml
steps:
  - id: pr
    run: [gh, pr, view, --json, number, --jq, .number]
  - id: save
    run: [hwf, scratch, set, triage.last_pr, "{{steps.pr.stdout}}"]
  - id: load
    run: [hwf, scratch, get, triage.last_pr]
  - agent: |
      The last PR number is {{steps.load.stdout}}.
    using: claude
```

From a terminal, the same commands work:

```bash
hwf scratch set triage.last_pr 42
hwf scratch get triage.last_pr
hwf scratch list
hwf scratch delete triage.last_pr
```

`list` prints one key per line. A missing key fails `get`. A write that crosses the 8 MiB capture cap fails and leaves the previous value unchanged.

A local `run:` step receives `HWF_RUN_ID`, `HWF_WORKFLOW`, and `HWF_CHECKOUT_ROOT`. To drop a key when that run expires, start the key with the run id and a dot:

```yaml
- id: mark
  run:
    - sh
    - -c
    - hwf scratch set "${HWF_RUN_ID}.status" "review"
```

Keys without that prefix stay until you delete them. The `scratch` command does not contact herdr. Command list: [Run and manage](/surfaces#the-cli). Limits: [Reference](/reference#scratch).

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
- **A command can use an earlier answer.** Put `{{inputs.<name>}}` in an argv element to cascade. Pick a repository, then pick one of that repository's branches. The reference must point at an input declared before this one, and if that input has a `when:`, this one repeats the same clauses. Change the earlier answer, and hwf looks up the later options again.
- **`allow_custom: true`** turns the options into suggestions and accepts any other text that you type. Select the `custom...` row to open a text field. It starts from the text that you typed for the filter.
- **`min_length`** rejects a value that is too short. Use `min_length: 1` to refuse an empty answer.
- **`when:`** removes an input from the prompt, based on an earlier answer. The example never asks for a branch in `status` mode, and does not run the branch-listing command either.

Write a `description` for every input. It is the only part of the prompt you control.

Inputs also reach `run:` steps as environment variables named `HWF_<name>`.

Check what a workflow will ask before you run it:

```bash
hwf workflow inspect branch-check
hwf workflow inspect branch-check --input mode=branch --resolve
```

Without `--resolve`, hwf prints a dynamic option command and does not run it.

## Put steps somewhere you can see

`run:` and `agent:` steps take a `pane:` block. Without one, an agent opens in a new tab. A command runs unseen, and the workflow waits for it.

```yaml
- run: [npm, run, dev]
  pane:
    open: beside # tab | beside | below
    size: 40 # percent of the anchor for the new pane, 1-99
    focus: true
  ready_when: /listening on/
  timeout: 30s
```

- **`open: beside` or `below`** splits the pane you started from. **`open: tab`** makes a new tab in the workspace you started from. Placement uses the IDs captured at the start. If you move your focus mid-run, nothing changes.
- **A placed command needs to say when it is ready.** Use `ready_when: /regex/` with a `timeout` to watch the pane's recent output for that pattern. Use `background: true` for something that you never wait for. The two are mutually exclusive.
- **`ready_when` watches text, not exit codes.** It succeeds when the pattern appears and fails when the timeout passes. It cannot tell you that the process died.
- **Background processes belong to their pane.** They survive when you detach your client. They do not survive a server restart, and a later failure elsewhere in the workflow will not stop them.
- **Agents can close their own pane** with `close: success` or `close: always`. `close` does not apply to commands.

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

- **`when:`** takes one condition or an ordered list of them, joined by AND and evaluated left to right. A condition is either a template read for truthiness or a comparison with `==` or `!=` against a quoted string. Empty string, `0`, `false`, and null are false. There is no OR, no parentheses, and no expressions. A false condition marks the step skipped and continues.
- **`success_codes:`** lists the exit codes you count as success. Probes that report a fact through their exit code, like `git diff --quiet`, need this.
- **`continue_on_error: true`** records the failure, continues, and does not trigger `on_failure` for that tolerated failure. A later non-tolerated failure can still trigger entry recovery. The run still exits nonzero at the end.
- **`retry:`** takes `attempts` (2 or more, with the first included) and an optional `delay`. Commands and `herdr:` calls only, never agents.
- **`on_failure:`** runs one action, once, after the first real failure anywhere in the run, even inside a child. Only the workflow you started can recover. `{{context.error}}` tells it what broke: message, workflow, action, step number, and details. The run still counts as failed.

If the connection to herdr drops mid-step, the run stops, keeps your panes, and skips `on_failure`. It will not retry, because it cannot know whether the step you dispatched finished.

## Hand your session to an agent

`{{context.transcript}}` and `{{context.transcript_file}}` carry your current session's transcript into a prompt. The [Handoff example](/examples) uses it to brief a fresh agent on everything that you did. This is the most sensitive thing a workflow can read, and every review surface marks it.

### Where the transcript comes from

hwf reads it once, before step 1, from the pane you launched the workflow from, never from an agent the workflow starts. So the agent that matters is the one you sit in, not the one in `using:`. If that read fails, the run stops there and no step executes.

Extraction is built-in for one kind: `claude`. It needs herdr's Claude integration installed, because that is what reports the session id:

```bash
herdr integration install claude
```

With that in place, hwf reads the session's `.jsonl` under `~/.claude/projects/`, keeps the user and assistant text, and drops tool traffic.

Every other kind, for example codex, opencode, and cursor, needs an extractor, or the run fails preflight.

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

It must exit 0, print something, finish inside 30 seconds, and produce at most 8 MiB. An entry replaces built-in extraction for that kind, so you can override `claude` too.

### Transcript limitations

- One transcript per run, taken before the first step. Nothing refreshes it mid-run.
- Only the invoking pane. There is no way to read another agent's history.
- That pane must have an agent in it. Launch from a plain shell and there is nothing to extract.
- `claude` is the only kind supported by default, and only with its herdr integration installed. You must write everything else.
- Failure is total, never partial. The run stops before step 1 on no extractor, an empty result, a timeout, or an oversized transcript. It never hands an agent half a session.

## Build with an agent instead

The `herdr-workflow-create` skill interviews you, writes the YAML, and validates the file with `hwf workflow validate` or the bundled `validate.sh` script before it saves. It ships inside the CLI. Hand its text to your agent:

```bash
hwf skills show herdr-workflow-create
```

To update existing workflows to a newer herdr, the sibling skill walks the version gates and repairs the known breakage classes:

```bash
hwf skills show herdr-workflow-upgrade
```

## Next

- [Run and manage workflows](/surfaces) — picker, CLI, scratch, sharing
- [Examples](/examples) — working workflows to import
- [Reference](/reference) — every field, limit, and rule
