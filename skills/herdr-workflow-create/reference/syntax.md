# Workflow syntax

## Contents

- File shape and top-level keys
- Inputs
- Action keys: `run`, `agent`, `use`, primitives
- Placement, wait, timeout
- Outputs (`out:`)
- Guards, loops, retry, failure handling
- Placeholders and the flat namespace
- Config (`agents:` / `sessions:`)
- Load-error catalogue

## File shape

One workflow = one YAML file. Top-level keys are strict — only these four:

```yaml
desc: shown in the picker # optional
inputs: {} # optional
on_error: <workflow-name> | [<steps>] # optional
steps: <string> | <step map> | [<step maps>] # required
```

`steps: bun test` (bare string) expands to one `run:` step. Steps execute top to bottom in
the foreground; there is no parallelism.

## Inputs

The picker asks one screen per declared input, in declaration order, before the run.
`hwf run` supplies them with `--input name=value`.

```yaml
inputs:
  branch: text # required free text
  focus: text = "" # optional free text with default
  base: [main, develop] = main # choice list + default
  ref: sh git branch --format='%(refname:short)' # choices from stdout lines
  target: agents # choices = configured agent names
  fancy: # map form when label/desc are needed
    type: text # text | agents
    label: focus area
    desc: optional hint
    options: [a, b] # or a shell command string
    default: a
```

- Names match `[a-z][a-z0-9_]{0,31}` and may not shadow a builtin.
- Reference as `{name}` — one flat namespace.
- **Every declared input must be referenced somewhere**, else load fails. A `$HWF_<name>`
  mention inside scalar/block `run:` text counts as a reference.
- A `default` outside `options` is a load error.
- `sh …` option commands run at load time from the repo root, 5s timeout, must print at
  least one non-empty line.
- `agents` requires at least one configured agent.
- Only the entry workflow prompts. `use:` targets receive values through `with:`.

## Action keys

Exactly one per step. Adding a second is a load error.

### `run:`

| Form   | Example                            | Shell                        | `{placeholders}` |
| ------ | ---------------------------------- | ---------------------------- | ---------------- |
| scalar | `run: git diff HEAD`               | yes (`shell:`, default `sh`) | **rejected**     |
| argv   | `run: [git, checkout, "{branch}"]` | no                           | allowed          |
| block  | `run: \|` + indented lines         | yes                          | **rejected**     |

`shell:` selects `sh` `bash` `zsh` `pwsh` `powershell` `cmd`; illegal on argv form and on
any non-`run:` step.

Scalar/block commands receive every bound name as an env var: `HWF_<name>` for inputs,
`out:` bindings, and builtins. That is the escape hatch for values in shell text:

```yaml
inputs:
  focus: text = ""
steps:
  - run: echo "$HWF_focus"
```

Local (`in: here`) commands are captured, not shown live in a pane, and are killed after
300s unless `timeout:` says otherwise.

### `agent:`

```yaml
- agent: claude # a key under agents: in .hwf/config.yaml
  prompt: | # optional, placeholders allowed
    Review this:
    {diff}
  in: tab # default for agent:
  timeout: 900 # seconds; default 1800
  out: brief # final pane text
```

The agent's argv template comes from config; `{prompt}` in that template is replaced with
the rendered prompt. Blocking wait polls agent status until done; a `blocked` agent raises
a herdr notification and keeps waiting. `agent: "{target}"` uses an input whose options are
all config agents; `agent: "{agent}"` is the invoking agent.

### `use:`

```yaml
- use: gate
  with: { suite: all }
```

Inlines another workflow (repo shadows global). The child sees only `with:` values plus
builtins; its `out:` names become visible downstream in the parent. Unknown target,
cycles, undeclared `with:` keys, missing required child inputs, and name collisions are
load errors. `on_error:` is not allowed on a `use:` step.

### Primitives (dotted herdr methods)

```yaml
- pane.split: { direction: right, ratio: 0.4 }
- worktree.create: { branch: "{branch}", base: main, focus: true }
    out: { path: worktree.path }
```

The key is the method name; the value is its params object (placeholders allowed inside
string values). Params are schema-checked at load. Omitted `pane_id` / `tab_id` /
`workspace_id` are auto-filled from the invoking context when the method accepts them.
See [herdr-api.md](herdr-api.md) for the allowlist, params, and result paths.

## Placement, wait, timeout

`in:` — `here` | `tab` | `right` | `down`. Default `here` for `run:`, `tab` for `agent:`
(`agent: in: here` behaves as `tab`). `right`/`down` split the invoking pane and fail at
runtime when there is no invoking pane. `ratio:` (0–1) only with `right`/`down`.
`cwd:` and `env:` are allowed on `run:` and `agent:` only.

`wait:` — omitted/`true` blocks (default), `false` detaches (cannot bind `out:`),
`/regex/` waits for matching pane output and requires a placed step.
`timeout:` is **seconds**: bounds the wait (agent default 1800, regex wait default 60,
local command default 300).

Blocking means "wait for the process" only for `agent:` and local `run:`. A placed `run:`
returns once its pane exists — the command keeps running in the pane and the workflow moves
on. To sequence on it, use `wait: /regex/`; to say so explicitly, use `wait: false`.

## Outputs

```yaml
- run: git diff HEAD
  out: diff # identifier: stdout of a local run
- agent: claude
  out: brief # identifier: final agent pane text
- run: lazygit
  in: tab
  out: { t: layout.tab_id, p: pane_id } # map: placed run
- workspace.create: { label: review }
  out: { ws: workspace.workspace_id } # map: primitive result path
```

- Identifier form on a placed `run:` is an error, and map form on a local `run:` or on
  `agent:` is an error.
- Map paths are checked at load against herdr's result union and again at run time. For a
  placed `run:` the usable paths are `pane_id`, `workspace_id`, `layout.tab_id`,
  `layout.focused_pane_id`, `layout.workspace_id` — bare `tab_id` is rejected.
- Names match `[a-z][a-z0-9_]{0,31}`, may not shadow builtins, may not collide with an
  input or an earlier binding.
- A skipped step binds its `out:` names to empty strings, so downstream `when:` still works.

## Guards, loops, retry, failure

| Key           | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `when:`       | `"{name}"` / `"!{name}"` (non-empty test), argv list, or shell string |
| `for:` `as:`  | literal list, `sh <cmd>`, or `"{name}"` (split on newlines); cap 100  |
| `retry:`      | integer, or `{ times, delay, until, reset }`                          |
| `allow_fail:` | `true` — record the failure and continue                              |
| `on_error:`   | workflow name or inline step list, one shot                           |
| `name:`       | label shown in progress output and the run log                        |

- A shell `when:` passes on exit 0. Skip is a distinct outcome from success and failure.
- Loops bind `{item}` and `{index}`; `as: path` adds `{path}` as an alias for `{item}`. All
  three resolve only inside the looping step — referencing them later is `unknown name`.
  Loops do not nest. A looped step with an identifier `out:` binds the newline-joined
  results of all iterations.
- `retry.times` ≥ 1, `delay` in seconds, `until` is a guard re-checked after each success,
  `reset` is a **shell command string** run between attempts. `retry:` on a pane-creating
  step (`agent:`, or `run:` with `in:` other than `here`) requires `reset:`.
- `{attempt}` is bound only inside a step that has `retry:`.
- `allow_fail: true` never triggers `on_error:`, but tolerated failures still make the
  whole run exit non-zero at the end.
- Step-level `on_error:` runs once and suppresses the workflow-level `on_error:`.
  `{error}` holds the message. Preflight failures (missing input, unresolved session or
  invoking agent) abort before any step and never trigger recovery.

## Placeholders

One flat namespace: builtins + input names + `out:` bindings. Unknown `{word}` is a load
error; non-identifier braces such as `{"json": true}` pass through untouched.

| Builtin            | Value                                               |
| ------------------ | --------------------------------------------------- |
| `{pane}`           | scrollback of the invoking pane                     |
| `{selection}`      | selected text in the invoking pane                  |
| `{prompt}`         | the picker's prompt line / `--prompt`               |
| `{session}`        | invoking agent's session transcript                 |
| `{session_file}`   | temp file holding that transcript                   |
| `{source_tab}`     | tab id the workflow was launched from               |
| `{agent}`          | name of the invoking agent                          |
| `{error}`          | failure message inside `on_error:`                  |
| `{item}` `{index}` | current loop item / 0-based position (needs `for:`) |
| `{attempt}`        | 1-based attempt number (needs `retry:`)             |

Legal in `prompt:`, argv elements, `cwd:`, `env:` values, `with:` values, and primitive
params. Rejected in scalar/block `run:` text.

## Config

```yaml
# .hwf/config.yaml (repo) merged over ~/.hwf/config.yaml (global), per name
agents:
  claude: ["claude", "{prompt}"] # exactly one literal "{prompt}" element
  codex: ["codex", "{prompt}"]
sessions:
  claude: ["my-session-dump"] # optional; stdout becomes {session}
```

`{session}` resolves via the `sessions:` command, else the built-in Claude JSONL reader,
else an error. Session commands receive `HERDR_WORKFLOWS_SESSION_ID`, `_CWD`, `_AGENT`.

## Load-error catalogue

Errors are positioned as `<file>, step <n>, <key>: <message>`.

| Message                                                      | Cause / fix                                  |
| ------------------------------------------------------------ | -------------------------------------------- |
| `placeholders are not allowed in shell command text`         | use argv form or `$HWF_<name>`               |
| `declared but never referenced`                              | drop the input or reference it               |
| `unknown name '{x}'`                                         | typo, missing `out:`, or an `as:` alias      |
| `step has no action key` / `multiple action keys`            | exactly one of run/agent/use/method per step |
| `unknown step key 'x'`                                       | not in the modifier list                     |
| `retry: on a pane-creating step requires reset:`             | add `reset: <shell command>`                 |
| `reset: must be a shell command string`                      | not a step list                              |
| `wait: /regex/ requires a placed step`                       | add `in: tab` / `right` / `down`             |
| `a detached step produces nothing to capture`                | drop `out:` or `wait: false`                 |
| `identifier out: on a placed run: is invalid`                | use map form                                 |
| `primitive steps require map-form out:`                      | `out: { name: dot.path }`                    |
| `out.<n>: unresolvable result path 'p'`                      | wrong dot-path — see herdr-api.md            |
| `name shadows a builtin` / `collides with an existing name`  | rename the binding                           |
| `unknown agent 'x'`                                          | not a key under `agents:`                    |
| `unknown herdr method 'x'` / `<reason>`                      | typo, or a denied method                     |
| `<method>: unknown param 'x'` / `missing required param 'x'` | check the method's params                    |
| `unknown workflow 'x'` / `cycle detected`                    | bad `use:` / `on_error:` target              |
| `required input 'x' of 'y' not supplied`                     | add it to `with:`                            |
| `recovery workflows cannot declare inputs`                   | strip `inputs:` from the `on_error:` target  |
| `for: resolved N items — cap is 100`                         | narrow the list (runtime error)              |
