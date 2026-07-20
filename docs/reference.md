# Reference

`hwf` ≡ `herdr-workflows`.

## CLI

| Command                                       | Does                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `hwf` (TTY)                                   | manage UI                                                         |
| `hwf run <name> [--prompt …] [--input k=v …]` | run; live progress/stderr; nonzero on fail                        |
| `hwf init [--force]`                          | write `.hwf/config.yaml` + `workflows/`; confirm before overwrite |
| `hwf launch` / `hwf picker`                   | picker popup                                                      |

## Picker

`1`–`9` select · text filters (exact name selects) · `>`/`<` page · `Esc` cancel. Declared `inputs:` ask one screen each (choice list with the same filter bar, or text line), then the prompt line only if the workflow uses `{prompt}`.

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

## Inputs

```yaml
inputs:
  <name>: # [a-z][a-z0-9_]{0,31}
    options: agents | <shell> | [<value>…] # present → choice
    label: <text> # picker screen title; default = name
    default: <value> # optional; picker prefill (text) / preselect (choice) / CLI fallback
```

| `options:`        | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `[a, b, …]`       | literal choices                                               |
| `agents`          | builtin — config agent names                                  |
| `"shell command"` | `sh -c` in repo cwd at load; non-empty stdout lines → choices |

`{input.<name>}` in `stdin` / `prompt` / `params`. `agent:` may be exactly `"{input.<name>}"` for a choice whose options are all config agents. Declare `inputs:` only on the entry workflow — spliced (`run:`) and recovery (`on_fail:`) targets may reference entry inputs but must not declare their own. Load errors: undeclared reference, declared-but-unused input, `inputs:` on spliced or recovery workflows, `options: agents` with empty config, options command fail/empty/timeout, default outside options. Picker: one screen per input (never skipped by `default`), declaration order, before the `{prompt}` line. Choice values validated again at run time. Options shell commands are author-controlled (same trust as workflow `shell:` steps).

## Verbs & modifiers

| Key        | Where              | Role                                              |
| ---------- | ------------------ | ------------------------------------------------- |
| `shell`    | step               | blocking `sh -c`; stdout → `{last}`; 300s         |
| `stdin`    | shell              | piped stdin; placeholders ok                      |
| `open`     | step               | new tab                                           |
| `wait_for` | open               | regex; block (default 60s)                        |
| `agent`    | step               | named config agent                                |
| `prompt`   | agent              | placeholders ok                                   |
| `wait`     | agent              | literal `done`; poll until finish (default 1800s) |
| `timeout`  | with wait/wait_for | seconds                                           |
| `herdr`    | step               | socket method                                     |
| `params`   | herdr              | placeholders in string values; ids auto-filled    |
| `run`      | step               | load-time splice                                  |
| `inputs`   | top-level          | declared user inputs; picker screens / `--input`  |
| `on_fail`  | top-level          | one-shot recovery workflow name                   |

Placeholders: `{pane}` `{selection}` `{prompt}` `{last}` `{error}` `{session}` `{tab}` `{prev_tab}` `{agent}` `{input.<name>}`. Only in `stdin`/`prompt`/`params` (and `agent: "{agent}"` / `agent: "{input.<name>}"`). `{session}` → `stdin` only.

## Semantics

- Linear foreground steps. First **step** failure → one notification → optional `on_fail` once. If recovery fails, that error is final (no nested `on_fail`).
- **Preflight** failures (e.g. `{session}` / `{agent}` required but unavailable) abort before any step — `on_fail` does not run.
- Run log = observability only (manage **Runs** tab). Optional sidebar: `$herdr-workflows` in herdr config.
- `run:` flattened + validated at load. Repo shadows global for names.
- herdr ≥ 0.7.4, POSIX. Keybinding installed into `config.toml` (no manifest field).
- `agent` / `open` push opened tab ids → `{tab}` / `{prev_tab}`.

## Ceilings

- `{pane}` / post-`wait: done` read: up to 100k lines (`recent-unwrapped`); still capped by herdr scrollback retention.
- `{session}` built-in: Claude JSONL only; others need `sessions:`.
- Fixed 300s shell timeout.
- No branches, loops, retries, parallelism, Windows.
