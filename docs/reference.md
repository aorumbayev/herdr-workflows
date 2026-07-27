# Reference

Every key and rule. `hwf` ≡ `herdr-workflows`.

## CLI

| Command                                                                | Does                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `hwf` (TTY, no args)                                                   | web workbench (same as `hwf web`)                                                                             |
| `hwf run <name> [--prompt …] [--input k=v …]`                          | run; live progress/stderr; nonzero on fail                                                                    |
| `hwf init [--force\|--yes]`                                            | write `.hwf/config.yaml` from the agents on PATH; seeds no workflows — [import an example](/examples) instead |
| `hwf workflow import "<base64>" [--to=repo\|global] [--yes] [--force]` | install a workflow bundle from the docs: shows the YAML, asks for consent, then asks for repo or global       |
| `hwf launch`                                                           | open the picker in a herdr popup pane                                                                         |
| `hwf picker`                                                           | run the picker full-screen in the current terminal (the popup's internal entrypoint)                          |
| `hwf web [--port <n>] [--no-open]`                                     | localhost workbench: browse/edit/validate/share workflows + config; default port 7317, auto-increments        |

### Web workbench

Localhost-only HTTP UI over the same core the CLI uses — browse repo + global workflows, edit with live validation (same errors as `hwf run`), edit config, browse the run log, and share via copy/download/move. **It never runs workflows** (needs herdr panes); it surfaces `hwf run <name>` instead. Bound to `127.0.0.1` with a per-launch token (`x-hwf-token`) and `Origin`/`Host` allowlist on every route.

## Picker

List: `type filter · ↑↓ move · enter run · esc cancel`. Choice input: `type filter · ↑↓ move · enter select · esc back`. Text input / prompt: `enter submit · esc back`.

Workflows with `hidden: true` are kept out of the picker — they're background halves meant to be spawned, not run by hand. `hwf run <name>` runs them fine, and the web workbench lists them under a separate _background_ heading.

Declared `inputs:` ask one screen each (declaration order), then the prompt line only if the workflow uses `{prompt}`.

## Files

| Path                                                              | Holds                      |
| ----------------------------------------------------------------- | -------------------------- |
| `.hwf/workflows/<name>.yaml`                                      | repo workflows             |
| `~/.hwf/workflows/<name>.yaml`                                    | global (repo shadows)      |
| `.hwf/config.yaml` / `~/.hwf/config.yaml`                         | agents + optional sessions |
| `$HERDR_PLUGIN_STATE_DIR/runs.jsonl` or `~/.hwf/state/runs.jsonl` | append-only history        |

Editor schema (optional): `# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json`

## Config

```yaml
agents:
  <name>: [<argv>…] # exactly one literal "{prompt}" element
sessions:
  <agent>:
    [<argv>…] # optional; stdout → {session}
    # env: HERDR_WORKFLOWS_SESSION_{ID,CWD,AGENT}
```

`{session}` resolve order: `sessions:` command → built-in Claude JSONL → error.

## Workflow shape

Top-level keys only: `desc`, `hidden`, `inputs`, `on_error`, `steps`. `hidden: true` keeps the workflow out of the picker (see [Background runs](#background-runs)). `steps` may be a bare command string (`steps: bun test` → one `run:` step), a single step map, or a list.

## Inputs

```yaml
inputs:
  branch: text                              # required free text
  focus: text = ""                          # optional free text
  base: [main, develop] = main              # choice + default
  ref: sh git branch --format='%(refname:short)'
  target: agents                            # config agent names
  fancy:                                    # map form when you need label/desc
    type: text
    label: focus area
    desc: optional hint
    default: ""
```

Names: `[a-z][a-z0-9_]{0,31}`. Reference as `{name}` (one flat namespace). Unused declared inputs are load errors. Default outside options is a load error. Only the entry workflow prompts; `use:` targets get values via `with:`.

Scalar/block `run:` steps receive bound names as `HWF_<name>` env (inputs and `out:` names) — except `{session}`, which holds a whole transcript and never enters the env; use `{session_file}` for shell access. The exported block is capped well under the ~32 KB platform ceiling; exceeding it fails the step with a named error instead of raw `E2BIG`. Prefer argv-form `run:` when values must be arguments.

## Action keys

Exactly one per step:

| Key           | Value                      | Role                                      |
| ------------- | -------------------------- | ----------------------------------------- |
| `run`         | scalar / argv list / block | local subprocess or placed command        |
| `agent`       | config agent name          | pane + prompt; waits by default           |
| `use`         | workflow name              | include another workflow (`with:` params) |
| `method.name` | params object              | any allowed herdr socket method           |

### `run:` forms

| Form   | Example                            | Shell?         | Placeholders |
| ------ | ---------------------------------- | -------------- | ------------ |
| scalar | `run: git diff HEAD`               | yes (`shell:`) | **rejected** |
| argv   | `run: [git, checkout, "{branch}"]` | no             | allowed      |
| block  | `run: \|\n  set -eu\n  bun test`   | yes            | **rejected** |

`shell:` selects `sh` / `bash` / `zsh` / `pwsh` / `powershell` / `cmd`; unset, it defaults to `sh` on POSIX and `cmd` on Windows. Illegal on argv form and on non-`run:` steps. Scalar form is shell-specific — `cmd` reads `%HWF_x%`, POSIX shells read `$HWF_x`; argv-form `run:` is the portable form.

### Placement (`in:`)

On `run:` / `agent:`: `here` \| `tab` \| `right` \| `down`. Defaults: `here` for `run:`, `tab` for `agent:`. `ratio:` only with `right`/`down`. `cwd:` / `env:` allowed on both. Placed steps take focus by default; `focus: false` opens the tab/split without stealing focus.

### Wait

Blocking is the default for `agent:` and for local `run:` (`in: here`) — the step ends when the process does. A **placed** `run:` (`in: tab` / `right` / `down`) hands the command to a herdr pane and returns as soon as that pane exists; herdr owns its lifetime. Gate on its progress with `wait: /regex/` (pane output). `wait: false` detaches: a placed step leaves the pane running, and an `in: here` step spawns the child fire-and-forget — ignored stdio, the parent's full environment, no timeout — and returns immediately. `timeout:` bounds the wait (never a detached step).

`close: true` on an `agent:` step closes its pane (and its tab, when the step created it) once the wait ends — after `out:` is captured, on success and failure alike; close failures are ignored (the pane is already gone). `close:` with `wait: false` is a load error.

### Outputs (`out:`)

- Identifier: text result (`run` here → stdout; `agent` → final response written to a runner-managed file) → `{name}`
- Map: `out: { p: pane.pane_id }` for structured primitive results (dot-paths checked against herdr result union at load; exact at run)

Detached steps cannot bind `out:`. Placed `run:` steps take the map form; their result exposes `pane_id`, `workspace_id`, and `layout.tab_id` (bare `tab_id` is not a union path).

An agent with identifier `out:` receives an appended instruction to write its final response to an absolute temporary path. The step fails if the agent does not create non-empty output. Terminal screen content is never used for the binding.

Loops bind `{item}` and `{index}`; `as:` renames the item inside that step, and both spellings resolve.

### Guards, loops, retry

| Key            | Role                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `when:`        | skip when false — `{name}` / `!{name}`, `{name} == "v"` / `!= "v"`, argv list, or shell string                  |
| `for:` / `as:` | sequential loop (literal list, `sh …`, or `{name}`); cap 100; no nesting                                        |
| `retry:`       | int or `{times, delay, until, reset}` (`reset` is a shell command string); pane-creating steps require `reset:` |
| `allow_fail:`  | record failure, continue; never triggers `on_error:`                                                            |
| `on_error:`    | workflow or step recovery (one-shot)                                                                            |
| `name:`        | progress label                                                                                                  |

Skip is a third outcome (not success, not failure). Skipped `out:` names bind empty so downstream `when:` chains.

### Primitives

Dotted herdr methods (`pane.split:`, `worktree.create:`, `notification.show:`, …). Params validated from vendored `schemas/herdr-api.schema.json` (`bun run schema:herdr`). Caller context autofills omitted `pane_id` / `tab_id` / `workspace_id` — except `workspace_id` on `layout.apply` when `tab_id` is set (herdr rejects both). `notification.show` fails the step when herdr reports `shown: false` (reason included); `busy` is retried 3× at 2s first, since another toast holding the screen clears on its own.

**Denied** (load error with reason): `server.*`, `plugin.*`, `events.subscribe`, `session.snapshot`, `popup.close`, `pane.graphics.*`, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`.

**Allowed areas:** `workspace.*`, `tab.*`, `pane.*` (minus denylist), `worktree.*`, `agent.*`, `layout.*`, `notification.show`, `client.window_title.*`, `ping`.

Startup compares pinned protocol with live herdr; mismatch names both numbers and `min_herdr_version`.

### Composition (`use:` / `with:`)

```yaml
steps:
  - use: gate
    with: { suite: all }
```

Repo shadows global. Cycles and unknown targets are load errors. Included workflows see only `with:` values + builtins; their `out:` names are visible downstream. A `use:` step accepts `name:`, `with:`, `when:`, and `allow_fail:` — `wait:` / `out:` / `timeout:` / `for:` / `as:` / `retry:` / `on_error:` on `use:` are load errors. A skipped `use:` binds its exported `out:` names empty, same as any skipped step.

## Namespace

Builtins: `{pane}` `{selection}` `{prompt}` `{session}` `{session_file}` `{source_tab}` `{agent}` `{error}` `{item}` `{index}` `{attempt}` `{platform}`.

`{platform}` is `macos` / `linux` / `windows`. Fork steps per OS with `when:` comparisons:

```yaml
steps:
  - run: [make, setup]
    when: '{platform} != "windows"'
  - run: [python, scripts/setup.py]
    when: '{platform} == "windows"'
```

`{session}` / `{session_file}` legal in `prompt:`, argv, and primitive params — rejected in scalar/block `run:` under the general placeholder rule.

Non-identifier braces (`{"json": true}`) pass through. Unknown `{word}` is a load error. To reuse a step's result, bind `out:` and reference it as `{name}`.

## Background runs

Fire-and-forget: an entry workflow whose last step re-invokes `hwf` detached.

```yaml
# ship.yaml
inputs:
  branch: text = main
steps:
  - run: bun test
  - run: [hwf, run, ship-bg, --input, "branch={branch}"]
    wait: false

# ship-bg.yaml
hidden: true
inputs:
  branch: text
steps:
  - agent: claude
    focus: false
    close: true
    prompt: "Deploy {branch}. Report tersely."
```

The detached `hwf run` child inherits the invoking environment, so `{agent}`, `{source_tab}`, and `{session_file}` resolve inside the background run. `hidden: true` keeps the background half out of the picker. `focus: false` keeps background panes from stealing focus; `close: true` reaps the agent pane when it finishes.

## Semantics

- Linear foreground steps. First hard failure → optional `on_error` once. Preflight failures skip `on_error`.
- Skip / success / failure are distinct in progress and the run log.
- herdr ≥ 0.7.5; macOS, Linux, Windows (fork steps per OS with `when:` + `{platform}`). Parallelism is out of scope.
- Schema regen: `bun run schema` (workflow JSON Schema) and `bun run schema:herdr` (method validators) — release-time; plugin build does not call `herdr api schema`.
