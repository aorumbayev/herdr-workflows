# Reference

`hwf` ≡ `herdr-workflows`. Syntax v2 — hard break from v1 (see [Changelog](/guide#breaking-change-syntax-v2) / `CHANGELOG.md`).

## CLI

| Command                                                 | Does                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hwf` (TTY, no args)                                    | web workbench (same as `hwf web`)                                                                         |
| `hwf run <name> [--prompt …] [--input k=v …]`           | run; live progress/stderr; nonzero on fail                                                                |
| `hwf init [--force\|--yes] [--seed=global\|repo\|none]` | write `.hwf/config.yaml` + repo `review`; optionally seed `handoff`/`worktree` (TTY asks; default global) |
| `hwf launch`                                            | open the picker in a herdr popup pane                                                                     |
| `hwf picker`                                            | run the picker full-screen in the current terminal (the popup's internal entrypoint)                      |
| `hwf web [--port <n>] [--no-open]`                      | localhost workbench: browse/edit/validate/share workflows + config; default port 7317, auto-increments    |

### Web workbench

Localhost-only HTTP UI over the same core the CLI uses — browse repo + global workflows, edit with live validation (same errors as `hwf run`), edit config, browse the run log, and share via copy/download/move. **It never runs workflows** (needs herdr panes); it surfaces `hwf run <name>` instead. Bound to `127.0.0.1` with a per-launch token (`x-hwf-token`) and `Origin`/`Host` allowlist on every route.

## Picker

List: `type filter · ↑↓ move · enter run · esc cancel`. Choice input: `type filter · ↑↓ move · enter select · esc back`. Text input / prompt: `enter submit · esc back`.

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

Top-level keys only: `desc`, `inputs`, `on_error`, `steps`. `steps` may be a bare command string (`steps: bun test` → one `run:` step), a single step map, or a list.

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

Names: `[a-z][a-z0-9_]{0,31}`. Reference as `{name}` (flat namespace — not `{input.name}`). Unused declared inputs are load errors. Default outside options is a load error. Only the entry workflow prompts; `use:` targets get values via `with:`.

Scalar/block `run:` steps receive every bound name as `HWF_<name>` env (inputs and `out:` names). Prefer argv-form `run:` when values must be arguments.

## Action keys

Exactly one per step:

| Key           | Value                      | Role                                      |
| ------------- | -------------------------- | ----------------------------------------- |
| `run`         | scalar / argv list / block | local subprocess or placed command        |
| `agent`       | config agent name          | pane + prompt; waits by default           |
| `use`         | workflow name              | include another workflow (`with:` params) |
| `method.name` | params object              | any allowed herdr socket method           |

### `run:` forms

| Form   | Example                            | Shell?                       | Placeholders |
| ------ | ---------------------------------- | ---------------------------- | ------------ |
| scalar | `run: git diff HEAD`               | yes (`shell:`, default `sh`) | **rejected** |
| argv   | `run: [git, checkout, "{branch}"]` | no                           | allowed      |
| block  | `run: \|\n  set -eu\n  bun test`   | yes                          | **rejected** |

`shell:` selects `sh` / `bash` / `zsh` / `pwsh` / `powershell` / `cmd`. Illegal on argv form and on non-`run:` steps.

### Placement (`in:`)

On `run:` / `agent:`: `here` \| `tab` \| `right` \| `down`. Defaults: `here` for `run:`, `tab` for `agent:`. `ratio:` only with `right`/`down`. `cwd:` / `env:` allowed on both.

### Wait

Blocking is the default. `wait: false` detaches. `wait: /regex/` waits for pane output (placed steps only). `timeout:` bounds the wait.

### Outputs (`out:`)

- Identifier: text result (`run` here → stdout; `agent` → final message) → `{name}`
- Map: `out: { pane: pane.pane_id }` for structured primitive results (dot-paths checked against herdr result union at load; exact at run)

Detached steps cannot bind `out:`.

### Guards, loops, retry

| Key            | Role                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| `when:`        | skip when false — `{name}` / `!{name}`, argv list, or shell string          |
| `for:` / `as:` | sequential loop (literal list, `sh …`, or `{name}`); cap 100; no nesting    |
| `retry:`       | int or `{times, delay, until, reset}`; pane-creating steps require `reset:` |
| `allow_fail:`  | record failure, continue; never triggers `on_error:`                        |
| `on_error:`    | workflow or step recovery (one-shot)                                        |
| `name:`        | progress label                                                              |

Skip is a third outcome (not success, not failure). Skipped `out:` names bind empty so downstream `when:` chains.

### Primitives

Dotted herdr methods (`pane.split:`, `worktree.create:`, `notification.show:`, …). Params validated from vendored `schemas/herdr-api.schema.json` (`bun run schema:herdr`). Caller context autofills omitted `pane_id` / `tab_id` / `workspace_id`.

**Denied** (load error with reason): `server.*`, `plugin.*`, `events.subscribe`, `session.snapshot`, `popup.close`, `pane.graphics.*`, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`.

**Allowed areas:** `workspace.*`, `tab.*`, `pane.*` (minus denylist), `worktree.*`, `agent.*`, `layout.*`, `notification.show`, `client.window_title.*`, `ping`.

Startup compares pinned protocol with live herdr; mismatch names both numbers and `min_herdr_version`.

### Composition (`use:` / `with:`)

```yaml
steps:
  - use: gate
    with: { suite: all }
```

Repo shadows global. Cycles and unknown targets are load errors. Included workflows see only `with:` values + builtins; their `out:` names are visible downstream.

## Namespace

Builtins: `{pane}` `{selection}` `{prompt}` `{session}` `{session_file}` `{source_tab}` `{agent}` `{error}` `{item}` `{index}` `{attempt}`.

`{session}` / `{session_file}` legal in `prompt:`, argv, and primitive params — rejected in scalar/block `run:` under the general placeholder rule.

Non-identifier braces (`{"json": true}`) pass through. Unknown `{word}` is a load error. No `{last}` / `{input.*}` — use named `out:` and `{name}`.

## Semantics

- Linear foreground steps. First hard failure → optional `on_error` once. Preflight failures skip `on_error`.
- Skip / success / failure are distinct in progress and the run log.
- herdr ≥ 0.7.5, POSIX. Parallelism and Windows are out of scope.
- Schema regen: `bun run schema` (workflow JSON Schema) and `bun run schema:herdr` (method validators) — release-time; plugin build does not call `herdr api schema`.

## v1 → v2 keys

| v1                   | v2                                      |
| -------------------- | --------------------------------------- |
| `shell:` (payload)   | `run:` (+ `shell:` = interpreter)       |
| `open:`              | `run:` with `in: tab`                   |
| `wait_for:`          | `wait: /regex/`                         |
| `wait: done`         | default blocking                        |
| `close_source:`      | `tab.close: { tab_id: "{source_tab}" }` |
| `herdr:` + `params:` | dotted method key                       |
| `run: <workflow>`    | `use:` + `with:`                        |
| `on_fail:`           | `on_error:`                             |
| `{last}`             | named `out:`                            |
| `{input.<name>}`     | `{name}`                                |
| `HWF_INPUT_*`        | `HWF_*` (inputs and outs)               |
