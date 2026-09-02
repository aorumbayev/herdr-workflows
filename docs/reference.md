# Reference

Everything the `v1alpha1` format accepts. Every rule lives on this page once. `docs/workflow.schema.json` gives editors the shape. The [guide](/guide) teaches by example and links here.

## Document

| Key           | Required | Notes                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `version`     | yes      | `v1alpha1`. Unknown values fail to load. A later format is `v1alphaN`  |
| `steps`       | yes      | Non-empty list                                                         |
| `title`       | no       | Picker label. Default: file name in title case                         |
| `description` | no       | Picker subtitle. Wraps to two lines, then truncates                    |
| `hidden`      | no       | Hides it from the picker. `hwf run` still works                        |
| `inputs`      | no       | Questions. Only the workflow you start asks them                       |
| `returns`     | no       | What this workflow gives back when another one calls it                |
| `on_failure`  | no       | One recovery action. Runs only in the workflow you start               |

No other top-level key.

| File rule | Value                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| Location  | `.hwf/workflows/` for one repo, `~/.hwf/workflows/` for every repo. Repo shadows global |
| Name      | `<name>.yaml`, name matches `[a-z0-9][a-z0-9-_]*`. `.yml` is not discovered        |

## Steps

Every step has exactly one action: `run`, `agent`, `herdr`, or `workflow`. Every step also accepts `id`, `when`, and `continue_on_error`. Any other key fails to load. That also applies to `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, and `as`.

`id` matches `[a-z][a-z0-9_]{0,31}`. You need it only when something reads the result of the step.

### `run:`

| Form   | Behavior                                                                  |
| ------ | ------------------------------------------------------------------------- |
| list   | Argv. Each item accepts templates. No shell for local or `open: tab`      |
| string | Shell source, `sh` unless `shell:` says otherwise. Rejects templates      |

| Field           | Rule                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `shell`         | `sh`, `bash`, `zsh`, `pwsh`, `powershell`, `cmd`. String form only. Windows values parse but never run natively |
| `cwd`           | Default: the directory that started the workflow                                                              |
| `env`           | Values accept templates. Runner values win over inherited ones. `HWF_` keys fail at runtime                   |
| `pane`          | Placement. Refer to [`pane:`](#pane)                                                                          |
| `background`    | Never wait. Needs a pane. No result                                                                           |
| `ready_when`    | `/regex/`. Needs `timeout`. Refer to [Background and readiness](#background-and-readiness)                   |
| `timeout`       | `<integer><ms\|s\|m\|h>`. Kills the command and its children. Invalid with `background`. Default: none           |
| `retry`         | Blocking local only. Refer to [Control flow](#control-flow)                                                   |
| `success_codes` | Non-empty unique integers. Default `[0]`. Blocking local only. `failed` reports against this list             |

| Result kind    | Fields                                                    |
| -------------- | --------------------------------------------------------- |
| blocking local | `stdout`, `stderr`, `exit_code`, `failed`                 |
| readiness      | native wait payload plus pane, tab, and workspace IDs     |
| background     | none                                                      |

Inputs arrive as `HWF_<name>` variables. Step results do not. Pass those with `env:`. Local commands also receive `HWF_RUN_ID`, `HWF_WORKFLOW`, and `HWF_CHECKOUT_ROOT`.

A placed command with `open: beside` or `below` runs the argv as one shell-quoted line in the new pane. `open: tab` runs the argv directly.

### `agent:`

The value is the prompt. Prompts always render as text.

| Field        | Rule                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `using`      | Profile name. Starts a new agent in a new pane. Accepts templates                              |
| `target`     | Agent name or pane ID that is already active. Must be idle or done. No `pane`, `cwd`, or `env` |
| neither      | Uses `default_profile`                                                                        |
| both         | Load error                                                                                    |
| `cwd`, `env` | As for `run:`. `env` forwards `HWF_` keys                                                     |
| `pane`       | Default: new tab in the invocation workspace                                                  |
| `background` | Needs a pane of its own, or a `target` that names an active agent                                         |
| `timeout`    | Turn deadline. Default 30 minutes. Startup has a separate 30-second deadline |
| `expect`     | Verdict token. Refer to [`expect:`](#expect)                                                  |

Result: `response`, `agent` (herdr's `AgentInfo`), `pane_id`, and `verdict` with `expect:`.

| Behavior          | Rule                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `blocked` agent   | One notification per episode. The step continues to wait                                                  |
| `unknown` agent   | Never counts as finished                                                                              |
| `context.agent`   | The name of the agent that invoked the workflow, or its pane ID when herdr reports no name. Started agents have no name     |
| self-target       | A workflow that targets `{{context.agent}}` must start while that agent is idle or done. An agent cannot run it on itself |

#### `expect:`

```yaml
expect:
  one_of: [APPROVE, REJECT]
  require: [APPROVE] # optional
```

| Field     | Rule                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| `one_of`  | Non-empty distinct tokens that match `[A-Z][A-Z0-9_]{0,31}`                                  |
| `require` | Optional non-empty subset. Omit it to accept every token and branch with `when:`           |
| `verdict` | The final non-empty line of the response. The runner trims it and matches it exactly. `response` keeps the full text |

The runner appends the token rules to the prompt, and the agent checks its own final line with `hwf response check` before it finishes.

A final line that matches no token fails the step. A verdict outside `require` fails the step. Both are ordinary failures: `continue_on_error` tolerates them and `on_failure` receives them.

Load errors: `expect` with `background: true`, `expect` on any other action, and a `{{steps.<id>.verdict}}` reference to a step without `expect`.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

| Field    | Rule                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| `params` | The method's exact request. Templates apply recursively                        |
| `retry`  | Refer to [Control flow](#control-flow)                                        |

The loader never autofills a target. It checks method names, parameter types, and result paths at load. Success gives you the complete result of the method. Denied methods fail at load. Refer to [Trust and sharing](#trust-and-sharing).

Required selectors for herdr 0.8.2:

| Method                                    | Needs                                        |
| ----------------------------------------- | -------------------------------------------- |
| `tab.create`                              | `workspace_id`                               |
| `pane.split`                              | `target_pane_id`                             |
| `layout.apply`, `layout.set_split_ratio`  | exactly one of their paired selectors        |
| `worktree.list`, `create`, `open`         | exactly one of `workspace_id` or `cwd`       |
| `pane.list`, `tab.list`                   | the filters stay optional                    |

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

| Rule       | Value                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| lookup     | Repo scope shadows global. Unknown name or cycle fails at load and names the path                       |
| edits      | Mid-run edits to a child apply to the next run                                                          |
| `inputs`   | Every key must be a declared child input. Every required child input needs a value. Values must be text |
| isolation  | The child gets only its own inputs and context. Its step IDs stay private                               |
| result     | The child's `returns:` becomes this step's result. Without it, a reference fails at load                |
| recovery   | A child's own `on_failure` does not run inside a parent                                                 |
| dynamic    | Child dynamic choices still resolve for each invocation                                                 |

### `returns:`

One whole-value template, or a named map of them. Keys match `[a-z][a-z0-9_]{0,31}`. A whole-value template may resolve to an object or array. Load errors: literal null, an empty map, a conditional step result (no guard can prove it), and `context.transcript` or `context.transcript_file`.

## `pane:`

```yaml
pane:
  open: tab # tab | beside | below. Required
  target: "…" # pane to split. beside/below only. Default: invocation pane
  workspace: "…" # tab only. Default: invocation workspace
  size: 40 # percent for the new pane, 1-99. beside/below only
  name: "…" # tab name. tab only. Default: the step ID, or hwf-agent. Templates allowed
  focus: true # default true for foreground, false for background
  close: success # agent only: success | always
```

| Rule       | Value                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| anchors    | IDs captured when the workflow started, never current focus. `beside` splits right, `below` splits down             |
| `size`     | herdr decides the effective split and may approximate an extreme value                                               |
| `name`     | Literal `beside` or `below` with `name` fails at load. With a templated `open`, `name` applies only when the step creates a tab. Blank render keeps the step ID |
| `close`    | `success` closes after the runner captures the response. `always` closes after any outcome. Invalid on commands and background steps |
| last tab   | When you close the last tab of a workspace, the workspace closes (herdr 0.8.0+). The runner does not guard against this. Place a pane you want to keep in a workspace that has another tab |
| templated  | `open` may be `{{inputs.name}}` when that input is an unconditional closed static choice whose options are only `tab`, `beside`, `below` |
| default    | An agent step without `pane:` gets a new tab in the invocation workspace. A command without `pane:` runs unseen     |

## Background and readiness

| Rule            | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `background`    | Needs a pane of its own, or a `target:` that names an active agent. Invalid with `ready_when`, `timeout`, `retry`, `close`. No detached local background |
| placed command  | Needs exactly one of `background` or `ready_when`                                                        |
| lifetime        | Background processes belong to their pane. They survive client detach, not server restart. A later failure does not stop them |
| result          | Background and skipped steps produce no result. Nothing can reference them                               |
| `ready_when`    | `/regex/`, non-empty, slash-delimited, flagless, checked at load. Needs `timeout`                        |
| match           | One logical line of the recent pane output, with no ANSI codes. Text already on screen counts             |
| outcome         | Succeeds on match, fails when the deadline passes. Cannot detect process exit                             |

## Templates

Three roots only: `{{inputs.name}}`, `{{steps.id.field}}`, `{{context.key}}`. There is no `{{scratch.*}}`. To read scratch, run `hwf scratch get` and use `{{steps.*.stdout}}`.

| Rule        | Value                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| whole value | Keeps its source type                                                                                                  |
| embedded    | Renders as text: strings unchanged, booleans lowercase, numbers decimal, null empty, arrays and objects compact JSON    |
| string `run:` | Templates are a load error. Use list form or `env:`                                                                  |
| load errors | Duplicate step IDs, unknown paths, forward references, references to background, skipped, or result-less steps         |

### Context

| Key                                             | Holds                                                         |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Where the workflow started. The runner captures them at start |
| `cwd`                                           | Project root of the invocation directory. Always set          |
| `selection`                                     | Selected text. Empty when there is none                       |
| `platform`                                      | `macos` or `linux`. Refer to [Portability](#portability)      |
| `transcript`, `transcript_file`                 | Session transcript. Sensitive. Fails preflight if unavailable |
| `error`                                         | Recovery only, inside `on_failure`                            |

A reference to an identity or transcript value that is not available fails preflight, before step 1.

Transcripts never enter the `HWF_` environment or run history, and every review surface marks them. The runner always removes transcript files. Failed runs keep response and prompt files in gitignored `.hwf/tmp` for diagnosis.

`context.error` fields:

| Field           | Holds                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `message`       | Failure text                                                                                                              |
| `workflow`, `workflow_path` | The workflow that failed. A child failure names the child                                                     |
| `action`, `step_number`, `step_id` | The failed step. `step_id` only when it had one                                                        |
| `details`       | Commands: `stdout`, `stderr`, `exit_code`. Placed steps: pane, tab, workspace IDs. Agents: profile, kind or target, pane IDs. herdr: `method` and reason. Workflows: child name |

## Inputs

| Field          | Rule                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| name           | `[a-z][a-z0-9_]{0,31}`. A declared input nothing references is a load error                |
| `type`         | `text`, `choice`, `profile`. Shorthand: a bare `text`, `profile`, or a plain option list   |
| `description`  | Shown in the prompt. Write one                                                             |
| `default`      | For a closed `choice` or `profile`, must be one of the values                              |
| `when`         | One clause or ordered list. References earlier inputs only                                 |
| `allow_custom` | `choice` only. Turns options into suggestions. Invalid on `text` and `profile`, even `false` |
| `min_length`   | Non-negative character floor for an active value                                           |
| `options`      | `choice` only. Static list, or `{run: argv}`                                               |

`profile` lists merged profile names in stable order and never exposes their `args`. Inputs reach `run:` steps as `HWF_<name>`.

| Topic          | Rule                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| guards         | An inactive input does not prompt, resolve, apply its default, enter the namespace, or export `HWF_`. If you supply a value for one, collection fails. That includes `--input branch=`. A reference to a guarded input is a load error unless the site that reads it carries every clause that guards it |
| dynamic        | `{run: argv}` runs from the repo root with the environment of the invocation and no partial input exports. Output splits on newlines, trims, drops empty lines, deduplicates, keeps first-seen order |
| dynamic fails  | Nonzero exit, empty output, more than 1,000 options, or output past 8 MiB fails collection                                                 |
| dynamic runs   | Load and list validate but never run it. Collection runs each active one once. Treat the commands as read-only |
| cascade        | An argv element may hold `{{inputs.<name>}}` for an earlier input. It lands as one element, and a shell never parses it again. `steps.*`, `context.*`, self, and forward references are load errors. A guarded source needs the same clauses on the consumer. If you change an earlier answer, hwf discards the later answers and their options |
| prompt         | Shows name, `description`, position, option count, custom allowed, default, `min_length`. Earlier answers stay listed                     |

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

`hwf workflow inspect <name>` prints dynamic argv and does not run it. `--resolve` runs only active dynamic options. A cascading choice resolves only when every referenced input arrives through `--input`. Otherwise the command prints its unresolved argv, and the independent choices still resolve.

## Control flow

| Construct           | Rule                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `when:`             | One clause or ordered list, short-circuit AND. False means skipped                                                   |
| clause              | A whole-value template read for truthiness, or one template compared with a quoted string by `==` or `!=`             |
| truthiness          | Empty string, boolean `false`, numeric `0`, and null are false. Every other value is true, and that includes the strings `"0"` and `"false"`. Comparison uses canonical text |
| load errors         | Shell commands, expressions, OR, parentheses, structured values                                                      |
| guarded results     | A conditional step's result may be read only where every one of its clauses is also present                          |
| `continue_on_error` | Records and continues. Does not trigger recovery for that failure. A later failure still can. The run exits nonzero  |
| `retry`             | `attempts` (2 or more, first included) plus optional `delay`. Blocking local `run:` and `herdr:` only               |
| `success_codes`     | Refer to [`run:`](#run)                                                                                              |
| `on_failure`        | One action, once, after the first non-tolerated failure anywhere in the run, including children                      |
| connection loss     | Stop, keep panes, skip recovery, report that the step may still run                                                 |

`continue_on_error` cannot make a result readable after a failure on `agent`, `herdr`, `workflow`, placed, readiness, or background steps. Spawn and runner failures stay hard failures.

`on_failure` rules:

| Rule       | Value                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| rejects    | `id`, `when`, `continue_on_error`, `background`, `retry`                                               |
| agent      | `using`, `target`, `cwd`, `env`, `pane`, `timeout`                                                     |
| command    | `shell`, `cwd`, `env`, `pane`, `ready_when`, `timeout`                                                 |
| herdr      | `params`                                                                                               |
| workflow   | `inputs`                                                                                               |
| outcome    | A recovery that fails is final. Parse, validation, and preflight failures never trigger it. Success does not make the run succeed |

## Config

```yaml
profiles:
  name:
    kind: claude # non-empty. herdr decides whether it starts
    args: ["--model", "…"] # optional
default_profile: name
transcripts:
  claude:
    command: [extractor, argv…]
```

| Rule              | Value                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| keys              | Only these three. `agents:` and `sessions:` fail                                                                      |
| profile name      | `[a-z][a-z0-9_-]{0,31}`. Fields: `kind` and `args` only                                                              |
| layers            | Global plugin config dir, then `.hwf/config.yaml`, then `.hwf/config.local.yaml`. A later layer replaces a whole entry |
| `default_profile` | Highest layer wins and must name a merged profile. Preflight fails when an agent step needs it and it is missing      |
| `using:` literal  | Unknown name fails at load. The runner checks a templated name when the step runs                                            |
| `transcripts`     | Keyed by herdr agent kind. Built-in for `claude`. Any other kind needs an entry or transcript context fails preflight. An entry replaces built-in extraction |

Extractor contract: it runs in the working directory of the agent. It must exit 0, print to stdout, finish in 30 seconds, and produce at most 8 MiB. Environment:

| Variable                       | Holds                                          |
| ------------------------------ | ---------------------------------------------- |
| `HWF_TRANSCRIPT_PANE_ID`       | The pane that launched the workflow            |
| `HWF_TRANSCRIPT_AGENT_KIND`    | The kind herdr detected there                  |
| `HWF_TRANSCRIPT_CWD`           | That agent's cwd, or the invocation cwd        |
| `HWF_TRANSCRIPT_SESSION_KIND`  | Session reference type, when herdr reports one |
| `HWF_TRANSCRIPT_SESSION_VALUE` | Session id or path, when herdr reports one     |

Transcript rules: one read per run, before step 1, from the pane that invoked the workflow only. That pane must hold an agent. Built-in `claude` extraction needs `herdr integration install claude` and reads the session `.jsonl` under `~/.claude/projects/`. It keeps the user and assistant text. Any failure stops the run before step 1. There is no partial transcript.

## Scratch

A flat key-value store shared by every run. The key is the whole identifier. No scopes, no hierarchy, no template. `hwf scratch` never contacts herdr.

| Command                         | Result                                      |
| ------------------------------- | ------------------------------------------- |
| `hwf scratch set <key> <value>` | Writes or replaces the value                |
| `hwf scratch get <key>`         | Prints the value. Missing key fails         |
| `hwf scratch list`              | Prints keys, one per line, in key order     |
| `hwf scratch delete <key>`      | Deletes the key                             |

A value uses the 8 MiB cap. A write that crosses it fails and leaves the previous value unchanged. hwf deletes keys that match `<run-id>.*` when that run expires. Other keys stay until you delete them.

## Limits

| What                                                                                         | Limit   |
| -------------------------------------------------------------------------------------------- | ------- |
| Generated `HWF_*` environment block                                                          | 24 KiB  |
| Inline agent prompt, then spilled to a file the agent is told to read                        | 16 KiB  |
| Clipboard paste into a picker text field                                                     | 16 KiB  |
| Command output, agent response, transcript, dynamic-option output, or scratch value (each)   | 8 MiB   |
| Raw `claude` session file loaded by built-in extraction                                      | 256 MiB |
| One record in a raw `claude` session file                                                    | 32 MiB  |
| Dynamic options                                                                              | 1,000   |
| Dynamic option command                                                                       | 10s     |
| Transcript extractor                                                                         | 30s     |
| Agent turn (default `timeout`)                                                               | 30m     |
| Agent startup                                                                                | 30s     |

A value that crosses a cap fails the step and names the source and the limit. The runner never truncates. The transcript cap applies to extracted text, not the raw file.

## Trust and sharing

A workflow file is code you choose to run. There is no sandbox. A `run:` step can call the whole herdr CLI or socket as you. When you open a repository, that never runs a workflow. The picker and CLI label repo or global provenance and mark commands, transcript references, and sensitive herdr methods.

| Denied methods                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `server.*`, `plugin.*`, `events.*`, `integration.*`, `pane.graphics.*`                                                                                                                                                           |
| `session.snapshot`, `popup.close`, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`, `agent.view.set`, `agent.view.clear`                                                          |

Allowed: `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`, `layout.*`, `notification.show`, `client.window_title.*`, `ping`. Each denial states the rule it protects. This is a rail against accidental misuse, not a security boundary.

| Bundles | Rule                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| format  | `hwf workflow import "<bundle>"`. The bundle is one opaque string                                                                          |
| content | The selected workflow and every `workflow:` child it reaches, repo first then global. Exact YAML bodies, with a `$schema` pointer when one exists. No version, root, source, or config |
| export  | A missing child or a cycle fails the export                                                                                               |
| import  | Previews every body and warning. Needs one `repo` or `global` destination. The scope becomes wholly the bundle or stays wholly as it was. Conflicts need `--force`. Without a terminal, needs `--yes` and `--to`. Neither surface can run what it imported |
| legacy  | A bundle from a version before 0.6 fails. Re-export it                                                                                    |

## Portability

`v1alpha1` syntax and argv behavior are the same on Linux and macOS. Windows runs herdr and the plugin inside WSL2, where Linux behavior applies. A string `run:` without `shell:` uses `sh`. For OS-specific steps, pair `{{context.platform}}` with `when:`. That is the only OS selection the format has.
