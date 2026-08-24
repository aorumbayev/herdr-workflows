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

The loader allows no other top-level key. An unrecognized `version` fails to load, with guidance to rewrite or upgrade. A later incompatible format uses `v1alphaN`. Workflow YAML never states a herdr version. The plugin manifest owns that.

## Steps

Every step carries exactly one action: `run`, `agent`, `herdr`, or `workflow`. Every step also accepts `id`, `when`, and `continue_on_error`. Any other key fails to load. This applies to `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, and `as`.

`id` matches `[a-z][a-z0-9_]{0,31}` and is only needed when something reads the step's result.

### `run:`

| Form   | Behavior                                                             |
| ------ | -------------------------------------------------------------------- |
| list   | Argv. Each item accepts templates. See [Placement](#pane)            |
| string | Shell source, `sh` unless `shell:` says otherwise. Rejects templates |

Blocking local result: `{stdout, stderr, exit_code, failed}`. A readiness run returns the native wait payload plus pane, tab, and workspace IDs. A background run has no result.

Other fields: `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`, `success_codes`.

- `shell` accepts `sh`, `bash`, `zsh`, `pwsh`, `powershell`, and `cmd`. The Windows values stay valid syntax for compatibility. The plugin does not support native Windows execution. `shell` is invalid on the list form.
- `cwd` defaults to the directory that started the workflow.
- `env` values accept templates. The plugin reserves the `HWF_` prefix for exported inputs: a `run:` step fails on such a key at runtime rather than at load, and an agent step forwards it. Runner values win over inherited ones.
- Inputs arrive as `HWF_<name>` variables. Step results do not. Pass those with `env:`.
- `timeout` accepts `<integer><ms|s|m|h>`. If you omit it, there is no workflow deadline. The command still must finish. A timeout kills the command and its children. `timeout` is invalid with `background`.
- `success_codes` is a non-empty list of unique integers, and defaults to `[0]`. Blocking local commands only. `failed` reports against this rule.

A placed command with `open: beside` or `open: below` keeps the pane that it split from: the runner calls `pane.split`, then sends the argv as one shell-quoted line through `pane.send_input`. herdr has no `pane.run` method, and `layout.apply` replaces a whole tab and does not keep live processes. `open: tab` launches the argv directly through `layout.apply`.

### `agent:`

The value is the prompt. `using:` starts a new agent from a profile. `target:` prompts one that is already active. They are mutually exclusive. If you omit both, the step uses `default_profile`.

| Mode      | What happens                                                  |
| --------- | ------------------------------------------------------------- |
| `using:`  | Create a pane, call `agent.start`, then `agent.prompt`        |
| `target:` | Require idle or done, then prompt. No `pane`, `cwd`, or `env` |

Result: `{response, agent, pane_id}`. `agent` is herdr's native `AgentInfo`. With `expect:`, the result also carries `verdict`.

Other fields: `cwd`, `env`, `pane`, `background`, `timeout`, `expect`.

- The turn waits 30 minutes unless `timeout` says otherwise. Agent startup has a separate 30-second deadline.
- A `blocked` agent sends one notification per episode and the step continues to wait. `unknown` never counts as finished.
- A response file unique to that step matches completion. Thus the runner does not mistake another turn that finishes first for yours.
- `target:` accepts an agent name or a pane ID. `{{context.agent}}` holds the invoking agent's name, or its pane ID when herdr reports no name. Agents your workflow starts have no name.
- A workflow that targets `{{context.agent}}` must start while that agent is idle or done. `prefix+k` from a settled pane works. If you ask the agent to run it, that cannot work.

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

- `one_of` is a non-empty list of distinct tokens that match `[A-Z][A-Z0-9_]{0,31}`. `require` is an optional non-empty subset that lets the step succeed. If you omit `require`, the step accepts every token and leaves the branching to `when:`.
- The runner appends the token list, the final-line rule, and an `hwf response check` command to the prompt. The agent reruns that command against its own response file until it exits 0.
- `verdict` is the final non-empty line of the response, trimmed and matched exactly. Reasoning before it is acceptable. `response` still holds the complete text.
- A final line that matches no token fails the step and names the expected tokens. A verdict outside `require` fails and names both the verdict and the required tokens. Both are ordinary failures: `continue_on_error` tolerates them and `on_failure` receives them.
- `expect` is a load error with `background: true`, and on the other three actions. A reference to `{{steps.<id>.verdict}}` when the step that produces it declares no `expect` is a load error.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

Other fields: `params`, `retry`.

The loader infers nothing. Every required or behavior-selecting parameter goes in `params:`, with the method's own field name. The loader rejects a focus-resolving method when you omit the selector parameter. For herdr 0.8.2 that means:

- `tab.create` needs `workspace_id`
- `pane.split` needs `target_pane_id`
- `layout.apply` and `layout.set_split_ratio` need exactly one of their paired selectors
- `worktree.list`, `create`, and `open` need exactly one of `workspace_id` or `cwd`

`pane.list` and `tab.list` keep their filters optional.

The loader checks method names, parameter types, and result paths against the vendored herdr API schema at load time. A denied method fails at load. Success gives you the method's complete result.

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

Other fields: `inputs`.

- The repo scope shadows the global scope. An unknown name or a cycle fails at load, and names the path.
- The entry load freezes the complete child graph for that run. Mid-run edits apply to the next run. Dynamic child choices still resolve for each invocation.
- The child receives only its own inputs and context. Its step IDs stay private.
- Every key you pass must be an input the child declares, and every required child input must get a value. Passed values must resolve to text. The loader rejects objects, arrays, numbers, booleans, and null.
- The child's `returns:` becomes this step's result. Without `returns:`, the step has no result and a reference to it fails at load.
- A child's own `on_failure` does not run inside a parent invocation.

### `returns:`

One whole-value template, or a named map of them. Keys match `[a-z][a-z0-9_]{0,31}`. A whole-value template may resolve to an object or array. The loader rejects literal null and empty maps. Returns cannot reference conditional step results because `returns:` has no guard that proves they are available. The loader rejects `context.transcript` and `context.transcript_file`, so a transcript cannot reach private per-run snapshot history through a result.

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

You must set `open`. `beside` splits right, `below` splits down. Placement uses IDs captured when the workflow started, never current focus.

herdr decides the effective split, so herdr may approximate an extreme `size` rather than refuse it.

Foreground panes take focus by default. Background panes do not. An agent step that omits the whole block gets a new tab in the invocation workspace.

`name` names the tab the step creates, at the moment it opens, so a `background: true` step gets a readable tab without a rename step. It takes templates. It is `tab` only, because `beside` and `below` join a tab the step did not create. A literal `beside` or `below` with `name` fails at load.

With a templated `open`, `name` applies only when the resolved placement creates a tab. Omit `name` to keep the step ID as the tab name. A `name` whose templates render to blank text keeps that same default, so the tab stays identifiable.

`close` applies only to agent panes this step created. `success` closes after the turn settles and the runner captures the response. `always` closes after any outcome. Omit it to keep the pane, which is what you want for diagnosis. `close` is invalid on commands and on background steps.

From herdr 0.8.0, when you close the pane that hosts a workspace's last tab, that action closes the workspace, the same as the TUI. The runner does not guard against this: place a pane you want to keep after `close` in a workspace that has another tab.

`pane.open` may be a whole-value `{{inputs.name}}` reference when that input is an unconditional, closed, static choice whose every option is `tab`, `beside`, or `below`.

## Background and readiness

`background: true` needs a pane of its own, unless `target:` already names an existing agent pane. You cannot combine it with `ready_when`, `timeout`, `retry`, or `close`. There is no detached local background.

Background processes belong to their pane. Lifetime details are in [the guide](/guide#put-steps-somewhere-you-can-see). Background and skipped steps produce no result, so nothing can reference them.

A placed foreground command needs exactly one of `background` or `ready_when`.

`ready_when: /regex/` requires a `timeout`. It calls `pane.wait_for_output` against the pane's `recent` source, across 80 rendered rows, with ANSI codes stripped, and matches one logical line. The pattern must be non-empty, slash-delimited, and flagless. The loader checks it at load time. The step succeeds when the pattern matches at any time from the pane creation, and this includes text already on screen. The step fails when the deadline passes. It cannot detect process exit.

## Templates

Use `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}`. Nothing else.

A whole-value template keeps its source type. An embedded template renders as text: strings unchanged, booleans lowercase, finite numbers in decimal, null as empty, arrays and objects as compact JSON. Agent prompts always render as text.

The loader rejects duplicate step IDs, unknown paths, forward references, and references to background, skipped, or otherwise result-less steps.

### Context

| Key                                             | Holds                                                         |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Where the workflow started                                    |
| `cwd`                                           | Project root of the invocation directory. Always set          |
| `selection`                                     | Selected text. Empty when there is none                       |
| `platform`                                      | `macos` or `linux`. Refer to [Portability](#portability)      |
| `transcript`, `transcript_file`                 | Session transcript. Sensitive. Fails preflight if unavailable |
| `error`                                         | Recovery only, inside `on_failure`                            |

The runner captures identity values at the start, and they do not follow your focus. A reference to an identity or transcript value that is not available fails preflight, before step 1.

Transcripts never enter the automatic `HWF_` environment or private per-run snapshot history, and every review surface marks them. The runner always removes transcript files. Successful runs also remove managed response and prompt spill files. Failed runs retain that managed output in gitignored `.hwf/tmp` for diagnosis.

`context.error` carries `message`, `workflow`, `action`, `step_number`, `workflow_path`, `details`, and `step_id` when the step had one. A child failure names the child's own action that failed and local step number. `details` holds what applies: `stdout`, `stderr`, and `exit_code` for commands. Pane, tab, and workspace IDs for placed steps. Profile, kind or target, and pane IDs for agents. `method` and reason for herdr calls. The child name for workflow steps.

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

**Guards.** An inactive input does not prompt, does not resolve, does not apply its default, does not enter the input namespace, and does not export an `HWF_` value. If you supply a value for one, collection fails. Scripted `hwf run` callers must omit the flag entirely, and this includes `--input branch=`. A reference to a guarded input is a load error unless the reading site carries every clause that guards it.

**Dynamic options.** `{run: argv}` runs from the repo root with the invoking environment and no partial input exports. Output splits on newlines, trims, drops empty lines, deduplicates, and keeps first-seen order. Nonzero exit, empty output, more than 1,000 options, or output past the capture cap fails collection. A load and a list validate the declaration but do not run it. Entry collection runs each active one once. A picker launch carries the resolved options to the detached run, so the run does not resolve them twice. Treat these commands as read-only.

**Cascading choices.** A dynamic argv element may hold `{{inputs.<name>}}` templates that name earlier declared inputs, so one choice can list the values of another. The answer lands as one argv element, and a shell never re-parses it. Substitution happens right before the command runs, so the options reflect the answer given a moment earlier. `steps.*` and `context.*` roots inside dynamic argv are load errors, and so are a self reference and a forward reference. A reference to a guarded input requires the consuming input's own `when:` to carry every clause that guards it. If you change an earlier answer, the workflow discards the later answers and the options resolved from them, so the next prompt lists a fresh domain.

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

**Prompts.** The picker states the input name, your `description`, the position in the sequence, and how to answer: how many options a resolved closed domain has, whether it accepts a custom value, and a text input's default and `min_length`. Answers so far stay listed below the prompt.

```bash
hwf workflow inspect <name>
hwf workflow inspect <name> --input mode=delete --resolve
```

Without `--resolve`, the command prints dynamic argv but does not run it. With it, only active dynamic options resolve, under the usual limits. A choice whose argv references earlier inputs resolves only when every referenced input arrives through `--input`. Otherwise the command prints its unresolved argv and the independent choices still resolve.

## Control flow

| Construct           | Behavior                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `when:`             | One clause or an ordered list. Short-circuit AND. Truthiness, or `==` / `!=`. False means skipped                           |
| Guarded results     | A conditional step's result may be read only where every one of its clauses is also present                                 |
| `continue_on_error` | Records and continues. Does not trigger recovery for that failure. A later non-tolerated failure can trigger entry recovery |
| `retry`             | `attempts` (2 or more, the first included) plus optional `delay`. Local `run:` and `herdr:` only                            |
| `on_failure`        | One action, once, after the first non-tolerated failure anywhere in the run                                                 |
| Connection loss     | Stop, keep panes, skip recovery, report that the step may still run                                                         |

A condition is a whole-value template read for truthiness, or a comparison of one whole-value template with a quoted string with `==` or `!=`. Empty string, `0`, `false`, and null are false. Every other scalar is true. Comparison uses the value's canonical text form. Shell commands, arbitrary expressions, OR, parentheses, and structured values are load errors.

You cannot use `continue_on_error` to make a result readable after a failure on `agent`, `herdr`, `workflow`, placed, readiness, or background steps, because those can fail and produce no result. Spawn and runner failures stay hard failures.

`on_failure` takes exactly one action and rejects `id`, `when`, `continue_on_error`, `background`, and `retry`. A recovery agent accepts `using`, `target`, `cwd`, `env`, `pane`, and `timeout`. A recovery command accepts `shell`, `cwd`, `env`, `pane`, `ready_when`, and `timeout`. A recovery herdr call accepts `params`, and a recovery workflow accepts `inputs`. A recovery action that fails is final and does not recurse. Parse, validation, and preflight failures never trigger recovery, and a successful recovery does not make the run succeed.

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

Only these three keys. The loader rejects `agents:` and `sessions:`. Profile names match `[a-z][a-z0-9_-]{0,31}`.

Layers, in increasing precedence: the global plugin config directory, `.hwf/config.yaml`, then `.hwf/config.local.yaml`. A later layer replaces a whole named entry. The highest-precedence `default_profile` wins and must name a merged profile. Preflight fails when an agent step needs a default and there is not a valid one.

**Transcript extractors** use the herdr agent kind as the key. The plugin has built-in extraction for `claude`. Any other kind needs an entry here, or a reference to transcript context fails preflight. A configured extractor replaces built-in extraction for that kind. The environment an extractor receives and its output rules are in [the guide](/guide#support-another-agent-kind).

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

If output crosses a cap, the step fails and names the source and the byte limit. The runner never truncates output silently, and it stops a streaming command at the process that produces it.

Built-in `claude` extraction applies the transcript cap to the extracted text, not the raw session file. Raw session files are mostly tool output the extractor discards.

The runner writes an agent prompt larger than 16 KiB to a file, and tells the agent to read that path.

## Trust and sharing

A workflow file is code you choose to run. There is no sandbox. A `run:` step can call the whole herdr CLI or socket as you.

When you open a repository, that never runs a workflow. The picker and CLI label repo or global provenance, and mark commands, transcript references, and sensitive herdr methods. Neither surface claims a per-run confirmation or a sandbox.

**Denied methods.** Every `server.*`, `plugin.*`, `events.*`, `integration.*`, and `pane.graphics.*` method, plus `session.snapshot`, `popup.close`, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`, `agent.view.set`, and `agent.view.clear`. Each denial states the rule it protects. Beyond those, the loader allows only `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`, `layout.*`, `notification.show`, `client.window_title.*`, and `ping`. The loader denies anything newly generated outside them until policy admits it. This is a rail against accidental misuse, not a security boundary.

**Bundles.** A share produces `hwf workflow import "<bundle>"`, where the bundle is a gzip-compressed, base64-encoded `{name, yaml}[]` list that carries the selected workflow and every `workflow:` child it reaches. It carries no version, root, source, or config metadata. How export walks children is in [Run and manage · Share](/surfaces#share-a-workflow).

An import previews every YAML body and warning, requires one `repo` or `global` destination, and leaves the scope wholly as the bundle or wholly as it was. The loader rejects the old `{v, name, body}` payload. Re-export instead. Neither surface can run what it imported. Surface behavior is in [Run and manage · Import](/surfaces#import-a-workflow).

## Portability

`v1alpha1` syntax and argv behavior work the same on Linux and macOS. Windows users run herdr and the plugin inside WSL2, where Linux behavior applies unchanged. What is possible at run time follows your installed herdr.

A string `run:` without `shell:` uses `sh`. For OS-specific steps, pair `{{context.platform}}` with `when:`. That is the only OS selection the format has.
