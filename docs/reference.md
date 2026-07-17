# Reference

`hwf` ≡ `herdr-workflows`.

## CLI

| Command                       | Does                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `hwf` (TTY)                   | manage UI                                                         |
| `hwf run <name> [--prompt …]` | run; live progress/stderr; nonzero on fail                        |
| `hwf init [--force]`          | write `.hwf/config.yaml` + `workflows/`; confirm before overwrite |
| `hwf launch` / `hwf picker`   | picker popup                                                      |

## Picker

`1`–`9` select · text filters (exact name selects) · `>`/`<` page · `Esc` cancel. Prompt line only if workflow uses `{prompt}`.

## Files

| Path                                                              | Holds                      |
| ----------------------------------------------------------------- | -------------------------- |
| `.hwf/workflows/<name>.yaml`                                      | repo workflows             |
| `~/.hwf/workflows/<name>.yaml`                                    | global (repo shadows)      |
| `.hwf/config.yaml` / `~/.hwf/config.yaml`                         | agents + optional sessions |
| `$HERDR_PLUGIN_STATE_DIR/runs.jsonl` or `~/.hwf/state/runs.jsonl` | append-only history        |

## Config

```yaml
agents:
  <name>: [<argv>…] # exactly one literal "{prompt}" element
sessions:
  <agent>:
    [<argv>…] # optional; stdout → {session}
    # env: HERDR_WORKFLOWS_SESSION_{ID,CWD,AGENT}
```

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
| `on_fail`  | top-level          | one-shot recovery workflow name                   |

Placeholders: `{pane}` `{selection}` `{prompt}` `{last}` `{error}` `{session}` `{tab}` `{prev_tab}` `{agent}`. Only in `stdin`/`prompt`/`params` (and `agent: "{agent}"`). `{session}` → `stdin` only.

## Semantics

- Linear foreground steps. First failure → one notification → optional `on_fail` once.
- Run log = observability only (manage **Runs** tab). Optional sidebar: `$herdr-workflows` in herdr config.
- `run:` flattened + validated at load. Repo shadows global for names.
- herdr ≥ 0.7.4, POSIX. Keybinding installed into `config.toml` (no manifest field).
- `agent` / `open` push opened tab ids → `{tab}` / `{prev_tab}`.

## Ceilings

- `{pane}` / post-`wait: done` read: up to 100k lines (`recent-unwrapped`); still capped by herdr scrollback retention.
- `{session}` built-in: Claude JSONL only; others need `sessions:`.
- Fixed 300s shell timeout.
- No branches, loops, retries, parallelism, Windows.
