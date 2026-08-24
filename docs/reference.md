# Reference

Everything the `v1alpha1` format accepts. The loader checks the rules across fields. `docs/workflow.schema.json` covers shape only.

## Document

| Key           | Required | Notes                                                    |
| ------------- | -------- | -------------------------------------------------------- |
| `version`     | yes      | Must be `v1alpha1`                                       |
| `steps`       | yes      | Non-empty list                                           |
| `title`       | no       | Picker label. Defaults to the file name in title case    |
| `description` | no       | Picker subtitle. Wraps to two lines, then truncates      |
| `hidden`      | no       | Hides it from the picker. `hwf run` still works          |
| `inputs`      | no       | Questions. Only the workflow you start asks them         |
| `returns`     | no       | What this workflow gives back when another one calls it  |
| `on_failure`  | no       | One recovery action. Runs only in the workflow you start |

No other top-level key is allowed. An unrecognized `version` fails to load, with guidance to rewrite or upgrade. A later incompatible format uses `v1alphaN`. Workflow YAML never states a herdr version — the plugin manifest owns that.

## Steps

Every step carries exactly one action: `run`, `agent`, `herdr`, or `workflow`. Every step also accepts `id`, `when`, and `continue_on_error`. Any other key fails to load, including `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, and `as`.

`id` matches `[a-z][a-z0-9_]{0,31}` and is only needed when something reads the step's result.

### `run:`

| Form   | Behavior                                                             |
| ------ | -------------------------------------------------------------------- |
| list   | Argv. Each item accepts templates. See [Placement](#pane)            |
| string | Shell source, `sh` unless `shell:` says otherwise. Rejects templates |

Blocking local result: `{stdout, stderr, exit_code, failed}`. A readiness run returns the native wait payload plus pane, tab, and workspace IDs. A background run has no result.

Other fields: `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`, `success_codes`.

- `shell` accepts `sh`, `bash`, `zsh`, `pwsh`, `powershell`, and `cmd`. The Windows values stay valid syntax for compatibility. Native Windows execution isn't supported. `shell` is invalid on the list form.
- `cwd` defaults to the directory the workflow was started from.
- `env` values accept templates. The `HWF_` prefix is reserved for exported inputs: a `run:` step fails on such a key at runtime rather than at load, and an agent step passes it through. Runner values win over inherited ones.
- Inputs arrive as `HWF_<name>` variables. Step results don't — pass those through `env:`.
- `timeout` accepts `<integer><ms|s|m|h>`. Omitting it means no workflow deadline. The command still has to finish. A timeout kills the command and its children. `timeout` is invalid with `background`.
- `success_codes` is a non-empty list of unique integers, and defaults to `[0]`. Blocking local commands only. `failed` reports against this rule.

A placed command with `open: beside` or `open: below` keeps the pane it split from: the runner calls `pane.split`, then sends the argv as one shell-quoted line through `pane.send_input`. herdr has no `pane.run` method, and `layout.apply` replaces a whole tab without keeping live processes. `open: tab` launches the argv directly through `layout.apply`.

### `agent:`

The value is the prompt. `using:` starts a new agent from a profile. `target:` prompts one that's already running. They're mutually exclusive. Omitting both uses `default_profile`.

| Mode      | What happens                                                  |
| --------- | ------------------------------------------------------------- |
| `using:`  | Create a pane, call `agent.start`, then `agent.prompt`        |
| `target:` | Require idle or done, then prompt. No `pane`, `cwd`, or `env` |

Result: `{response, agent, pane_id}`. `agent` is herdr's native `AgentInfo`. With `expect:`, the result also carries `verdict`.

Other fields: `cwd`, `env`, `pane`, `background`, `timeout`, `expect`.

- The turn waits 30 minutes unless `timeout` says otherwise. Agent startup has a separate 30-second deadline.
- A `blocked` agent sends one notification per episode and the step keeps waiting. `unknown` never counts as finished.
- Completion is matched by a response file unique to that step, so another turn finishing first can't be mistaken for yours.
- `target:` accepts an agent name or a pane ID. `{{context.agent}}` holds the invoking agent's name, or its pane ID when herdr reports no name. Agents your workflow starts have no name.
- A workflow targeting `{{context.agent}}` has to start while that agent is idle or done. `prefix+k` from a settled pane works. Asking the agent to run it can't work.

#### `expect:`

```yaml
- id: review
  agent: Review this diff, findings first, verdict last.
  using: claude
  expect:
    one_of: [APPROVE, REJECT]
    require: [APPROVE] # optional
```

`expect` turns the answer into one addressable token, so a later `when:` compares `{{steps.review.verdict}}` instead of the whole response.

- `one_of` is a non-empty list of distinct tokens matching `[A-Z][A-Z0-9_]{0,31}`. `require` is an optional non-empty subset that lets the step succeed. Omitting `require` accepts every token and leaves the branching to `when:`.
- The runner appends the token list, the final-line rule, and an `hwf response check` command to the prompt. The agent reruns that command against its own response file until it exits 0.
- `verdict` is the final non-empty line of the response, trimmed and matched exactly. Reasoning above it is fine. `response` still holds the complete text.
- A final line that matches no token fails the step and names the expected tokens. A verdict outside `require` fails and names both the verdict and the required tokens. Both are ordinary failures: `continue_on_error` tolerates them and `on_failure` sees them.
- `expect` is a load error with `background: true`, and on the other three actions. Referencing `{{steps.<id>.verdict}}` when the producing step declares no `expect` is a load error.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

Other fields: `params`, `retry`.

Nothing is inferred. Every required or behavior-selecting parameter goes in `params:`, using the method's own field name. A method that would otherwise resolve a target from live UI focus is rejected without it. For herdr 0.8.2 that means:

- `tab.create` needs `workspace_id`
- `pane.split` needs `target_pane_id`
- `layout.apply` and `layout.set_split_ratio` need exactly one of their paired selectors
- `worktree.list`, `create`, and `open` need exactly one of `workspace_id` or `cwd`

`pane.list` and `tab.list` keep their filters optional.

Method names, parameter types, and result paths are checked against the vendored herdr API schema at load time. A denied method fails at load. Success gives you the method's complete result.

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

Other fields: `inputs`.

- The repo scope shadows the global scope. An unknown name or a cycle fails at load, naming the path.
- The entry load freezes the complete child graph for that run. Mid-run edits apply to the next run. Dynamic child choices still resolve for each invocation.
- The child sees only its own inputs and context. Its step IDs stay private.
- Every key you pass has to be an input the child declares, and every required child input has to get a value. Passed values must resolve to text: objects, arrays, numbers, booleans, and null are rejected.
- The child's `returns:` becomes this step's result. Without `returns:`, the step has no result and referencing it fails at load.
- A child's own `on_failure` doesn't run inside a parent invocation.

### `returns:`

One whole-value template, or a named map of them. Keys match `[a-z][a-z0-9_]{0,31}`. A whole-value template may resolve to an object or array. Literal null and empty maps are rejected. Returns cannot reference conditional step results because `returns:` has no guard that proves they are available. `context.transcript` and `context.transcript_file` are rejected, so a transcript can't reach private per-run snapshot history through a result.

## `pane:`

```yaml
pane:
  open: tab # tab | beside | below
  target: "…" # pane to split. beside/below only. Default: invocation pane
  workspace: "…" # tab only. Default: invocation workspace
  size: 40 # percent for the NEW pane, 1-99. beside/below only
  name: "…" # name for the new tab. tab only. Default: the step ID
  focus: true
  close: success # agent only: success | always
```

`open` is required. `beside` splits right, `below` splits down. Placement uses IDs captured when the workflow started, never current focus.

herdr decides the effective split, so an extreme `size` may be approximated rather than refused.

Foreground panes take focus by default. Background panes don't. An agent step that omits the whole block gets a new tab in the invocation workspace.

`name` names the tab the step creates, at the moment it opens, so a `background: true` step gets a readable tab without a rename step. It takes templates. It is `tab` only, because `beside` and `below` join a tab the step did not create. A literal `beside` or `below` with `name` fails at load. With a templated `open`, `name` applies only when the resolved placement creates a tab. Omit `name` to keep the step ID as the tab name. A `name` whose templates render to blank text keeps that same default, so the tab stays identifiable.

`close` applies only to agent panes this step created. `success` closes after the turn settles and the response is captured. `always` closes after any outcome. Omit it to keep the pane, which is what you want for diagnosis. `close` is invalid on commands and on background steps.

Since herdr 0.8.0, closing the pane that hosts a workspace's last tab closes that workspace, matching the TUI. The runner does not guard against this: place a pane you want to survive `close` in a workspace that has another tab.

`pane.open` may be a whole-value `{{inputs.name}}` reference when that input is an unconditional, closed, static choice whose every option is `tab`, `beside`, or `below`.

## Background and readiness

`background: true` needs a pane of its own, unless `target:` already names an existing agent pane. It can't be combined with `ready_when`, `timeout`, `retry`, or `close`. There's no detached local background.

Background processes belong to their pane — lifetime details are in [the guide](/guide#put-steps-somewhere-you-can-see). Background and skipped steps produce no result, so nothing can reference them.

A placed foreground command needs exactly one of `background` or `ready_when`.

`ready_when: /regex/` requires a `timeout`. It calls `pane.wait_for_output` against the pane's `recent` source, across 80 rendered rows, with ANSI codes stripped, matching one logical line. The pattern must be non-empty, slash-delimited, and flagless, and it's checked at load time. The step succeeds when the pattern has matched since the pane was created, including text already on screen, and fails when the deadline passes. It can't detect process exit.

## Templates

Use `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}`. Nothing else.

A whole-value template keeps its source type. An embedded template renders as text: strings unchanged, booleans lowercase, finite numbers in decimal, null as empty, arrays and objects as compact JSON. Agent prompts always render as text.

The loader rejects duplicate step IDs, unknown paths, forward references, and references to background, skipped, or otherwise result-less steps.

### Context

| Key                                             | Holds                                                         |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Where the workflow started                                    |
| `cwd`                                           | Project root of the invocation directory. Always set          |
| `selection`                                     | Selected text. Empty when there's none                        |
| `platform`                                      | `macos` or `linux`. See [Portability](#portability)           |
| `transcript`, `transcript_file`                 | Session transcript. Sensitive. Fails preflight if unavailable |
| `error`                                         | Recovery only, inside `on_failure`                            |

Identity values are captured at the start and don't follow your focus. Referencing an identity or transcript value that isn't available fails preflight, before step 1.

Transcripts never enter the automatic `HWF_` environment or private per-run snapshot history, and every review surface marks them. Transcript files are always removed. Successful runs also remove managed response and prompt spill files. Failed runs retain that managed output in gitignored `.hwf/tmp` for diagnosis.

`context.error` carries `message`, `workflow`, `action`, `step_number`, `workflow_path`, `details`, and `step_id` when the step had one. A child failure names the child's own failing action and local step number. `details` holds what applies: `stdout`, `stderr`, and `exit_code` for commands. Pane, tab, and workspace IDs for placed steps. Profile, kind or target, and pane IDs for agents. `method` and reason for herdr calls. The child name for workflow steps.

## Inputs

| Field          | Notes                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| `type`         | `text`, `choice`, or `profile`                                          |
| `description`  | Shown in the prompt. Write one                                          |
| `default`      | For a closed `choice` or `profile`, must be one of the available values |
| `when`         | One clause or an ordered list. References earlier inputs only           |
| `allow_custom` | `choice` only. Turns options into suggestions                           |
| `min_length`   | Non-negative character floor for an active value                        |
| `options`      | `choice` only. A static list, or `{run: argv}`                          |

Names match `[a-z][a-z0-9_]{0,31}`. A declared input nothing references is a load error. A shorthand value works too: `text`, `profile`, or a plain list of options.

`profile` lists merged profile names in a stable order and never exposes their `args`.

**Guards.** An inactive input doesn't prompt, doesn't resolve, doesn't apply its default, doesn't enter the input namespace, and doesn't export an `HWF_` value. Supplying a value for one fails collection — scripted `hwf run` callers must leave the flag off entirely, including `--input branch=`. Referencing a guarded input is a load error unless the reading site carries every clause that guards it.

**Dynamic options.** `{run: argv}` runs from the repo root with the invoking environment and no partial input exports. Output splits on newlines, trims, drops empty lines, and deduplicates while keeping first-seen order. Nonzero exit, empty output, more than 1,000 options, or crossing the capture cap fails collection. Loading and listing validate the declaration without running it. Entry collection runs each active one once. A picker launch carries the resolved options to the detached run so they aren't looked up twice. Treat these commands as read-only.

**Cascading choices.** A dynamic argv element may hold `{{inputs.<name>}}` templates that name earlier declared inputs, so one choice can list the values of another. The answer lands as one argv element, never re-parsed by a shell. Substitution happens right before the command runs, so the options reflect the answer given a moment earlier. `steps.*` and `context.*` roots inside dynamic argv are load errors, and so are a self reference and a forward reference. Referencing a guarded input requires the consuming input's own `when:` to carry every clause that guards it. Changing an earlier answer discards the later answers and the options resolved from them, so the next prompt lists a fresh domain.

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

**Prompts.** The picker states the input name, your `description`, the position in the sequence, and how to answer: how many options a resolved closed domain has, whether a custom value is accepted, and a text input's default and `min_length`. Answers so far stay listed below the prompt.

```bash
hwf workflow inspect <name>
hwf workflow inspect <name> --input mode=delete --resolve
```

Without `--resolve`, dynamic argv is printed, not run. With it, only active dynamic options resolve, under the usual limits. A choice whose argv references earlier inputs resolves only when every referenced input arrives through `--input`. Otherwise its unresolved argv is printed and the independent choices still resolve.

## Control flow

| Construct           | Behavior                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `when:`             | One clause or an ordered list. Short-circuit AND. Truthiness, or `==` / `!=`. False means skipped                           |
| Guarded results     | A conditional step's result may be read only where every one of its clauses is also present                                 |
| `continue_on_error` | Records and continues. Does not trigger recovery for that failure. A later non-tolerated failure can trigger entry recovery |
| `retry`             | `attempts` (2 or more, counting the first) plus optional `delay`. Local `run:` and `herdr:` only                            |
| `on_failure`        | One action, once, after the first non-tolerated failure anywhere in the run                                                 |
| Connection loss     | Stop, keep panes, skip recovery, report that the step may still be running                                                  |

A condition is a whole-value template read for truthiness, or a comparison of one whole-value template with a quoted string using `==` or `!=`. Empty string, `0`, `false`, and null are false. Every other scalar is true. Comparison uses the value's canonical text form. Shell commands, arbitrary expressions, OR, parentheses, and structured values are load errors.

`continue_on_error` can't be used to make a result readable after a failure on `agent`, `herdr`, `workflow`, placed, readiness, or background steps, because those can fail without producing one. Spawn and runner failures stay hard failures.

`on_failure` takes exactly one action and rejects `id`, `when`, `continue_on_error`, `background`, and `retry`. A recovery agent accepts `using`, `target`, `cwd`, `env`, `pane`, and `timeout`. A recovery command accepts `shell`, `cwd`, `env`, `pane`, `ready_when`, and `timeout`. A recovery herdr call accepts `params`, and a recovery workflow accepts `inputs`. A failing recovery action is final and doesn't recurse. Parse, validation, and preflight failures never trigger recovery, and a successful recovery doesn't make the run succeed.

## Config

```yaml
profiles:
  name:
    kind: claude # non-empty. Live agent.start decides whether it works
    args: ["--model", "…"] # optional
default_profile: name
transcripts:
  claude:
    command: [extractor, argv…]
```

Only these three keys. `agents:` and `sessions:` are rejected. Profile names match `[a-z][a-z0-9_-]{0,31}`.

Layers, in increasing precedence: the global plugin config directory, `.hwf/config.yaml`, then `.hwf/config.local.yaml`. A later layer replaces a whole named entry. The highest-precedence `default_profile` wins and has to name a merged profile. Preflight fails when an agent step needs a default and there isn't a valid one.

**Transcript extractors** are keyed by herdr agent kind. Extraction is built in for `claude`. Any other kind needs an entry here, or referencing transcript context fails preflight. A configured extractor replaces built-in extraction for that kind. The environment an extractor receives and its output rules are in [the guide](/guide#support-another-agent-kind).

## Limits

| What                                                                        | Limit   |
| --------------------------------------------------------------------------- | ------- |
| Generated `HWF_*` environment block                                         | 24 KiB  |
| Inline agent prompt                                                         | 16 KiB  |
| Command output, agent response, transcript, or dynamic-option output (each) | 8 MiB   |
| Raw `claude` session file loaded by built-in extraction                     | 256 MiB |
| One record in a raw `claude` session file                                   | 32 MiB  |
| Dynamic options                                                             | 1,000   |
| Dynamic option command                                                      | 10s     |
| Transcript extractor                                                        | 30s     |
| Agent turn (default `timeout`)                                              | 30m     |
| Agent startup                                                               | 30s     |

Crossing an output cap fails the step and names the source and the byte limit. Output is never silently truncated, and a streaming command is stopped at the process producing it.

Built-in `claude` extraction applies the transcript cap to the extracted text, not the raw session file — raw session files are mostly tool output the extractor discards.

An agent prompt larger than 16 KiB is written to a file, and the agent is told to read that path.

## Trust and sharing

A workflow file is code you're choosing to run. There's no sandbox. A `run:` step can call the whole herdr CLI or socket as you.

Opening a repository never runs a workflow. The picker and CLI label repo or global provenance, and mark commands, transcript references, and sensitive herdr methods. Neither surface claims a per-run confirmation or a sandbox.

**Denied methods.** Every `server.*`, `plugin.*`, `events.*`, `integration.*`, and `pane.graphics.*` method, plus `session.snapshot`, `popup.close`, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`, `agent.view.set`, and `agent.view.clear`. Each denial states the rule it protects. Beyond those, only `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`, `layout.*`, `notification.show`, `client.window_title.*`, and `ping` are allowed. Anything newly generated outside them is denied until policy admits it. This is a rail against accidental misuse, not a security boundary.

**Bundles.** Sharing produces `hwf workflow import "<bundle>"`, where the bundle is a gzip-compressed, base64-encoded `{name, yaml}[]` list carrying the selected workflow and every `workflow:` child it reaches. It carries no version, root, source, or config metadata. How export walks children is in [Run and manage · Share](/surfaces#share-a-workflow).

An import previews every YAML body and warning, requires one `repo` or `global` destination, and leaves the scope wholly as the bundle or wholly as it was. The old `{v, name, body}` payload is rejected — re-export instead. Neither surface can run what it imported. Surface behavior is in [Run and manage · Import](/surfaces#import-a-workflow).

## Portability

`v1alpha1` syntax and argv behavior work the same on Linux and macOS. Windows users run herdr and the plugin inside WSL2, where Linux behavior applies unchanged. What's possible at run time follows your installed herdr.

A string `run:` without `shell:` uses `sh`. For OS-specific steps, pair `{{context.platform}}` with `when:` — that's the only OS selection the format has.
