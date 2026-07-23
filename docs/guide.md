# Guide

Linear path from install to writing your own workflows. Lookup tables live in the [Reference](/reference).

## Install

Needs [herdr](https://herdr.dev) ≥ 0.7.5.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

That compiles the plugin, puts `hwf` (≡ `herdr-workflows`) on your PATH, and binds `prefix+k` to the picker.

## Set up a repo

```bash
cd your-repo
hwf init
```

Writes `.hwf/config.yaml` (agent definitions) plus a starter `review` workflow, and asks where to seed the `handoff` / `worktree` recipes (`--seed=global|repo|none` to skip the prompt).

## Run your first workflow

```yaml
# .hwf/workflows/scratch.yaml
steps:
  - open: lazygit
```

- `prefix+k` → type `scratch` → enter. Done.
- Same thing from a terminal: `hwf run scratch` (live step output — best for debugging).
- Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global, every project). Repo shadows global on the same name.

## Pick a surface

| Where                     | Use it for                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `prefix+k` (picker)       | running — collects inputs and a prompt line, then fires        |
| `hwf run <name>`          | running from scripts/terminal, with `--input k=v` / `--prompt` |
| `hwf web` (or bare `hwf`) | editing — browser workbench: build, validate, share, run log   |

The web workbench never runs workflows — running needs real herdr panes. It shows you the `hwf run <name>` line to paste instead.

## The five verbs

One verb per step. Steps run top to bottom.

- `shell: <cmd>` — blocking `sh -c` in the repo root. Stdout becomes `{last}` for later steps.
- `open: <cmd>` — fire a command in a new herdr tab. `wait_for: <regex>` makes it block until output matches.
- `agent: <name>` — launch a configured agent in a new tab. `wait: done` blocks until it finishes; `close_source: true` closes the invoking tab after the new one opens.
- `herdr: <method>` — call herdr's socket API with `params:`.
- `run: <workflow>` — splice another workflow's steps in here (composition).

`shell` vs `agent`: use `shell` for one-shot CLI calls (`claude -p …`), `agent` when you want an interactive pane a human can watch.

## Placeholders

Workflows get data through placeholders — but **only** inside `stdin`, `prompt`, and `params` strings. A placeholder in `shell:` / `open:` command text is a load error:

```yaml
# ✗ load error            # ✓
- shell: echo {pane}      - shell: claude -p "summarize"
                            stdin: "{pane}"
```

The everyday three: `{pane}` (invoking pane's scrollback), `{prompt}` (one ad hoc line from the picker or `--prompt`), `{last}` (previous step's output). Full list: [Reference](/reference#verbs--modifiers).

## Inputs

When a run needs named values, declare them:

```yaml
inputs:
  branch:
    options: "git branch --format='%(refname:short)'"
  focus:
    default: ""
steps:
  - agent: claude
    prompt: "Branch {input.branch}\nFocus: {input.focus}\n\n{pane}"
```

The picker asks one screen per input (choice list with type-to-filter, or a text line); the CLI takes `--input branch=main --input focus=perf`. `options:` can be a literal list, the builtin `agents` (your config's agent names), or a shell command whose stdout lines become choices. Rules and validation: [Reference](/reference#inputs).

Inside `shell:` commands, read inputs from `HWF_INPUT_<name>` environment variables — never interpolate `{input.*}` into command text.

## Failure handling

`on_fail: <workflow>` on the entry workflow runs a recovery sequence once if a step fails:

```yaml
on_fail: continue
steps:
  - run: gate
  - shell: git push
```

Recovery sees everything the original run saw, plus `{error}`. It runs once, may not declare its own `inputs:`, and only the entry workflow may declare `on_fail`.

## Web workbench

```bash
hwf web   # opens http://127.0.0.1:7317/?token=… — or just run bare `hwf`
```

- **Workflows** tab: text editor with live validation, or visual mode (drag-reorderable step cards that round-trip to YAML). Copy, download, move between repo/global, delete.
- **Config** tab: edit repo/global `config.yaml`.
- **Runs** tab: read-only run history.

Bound to `127.0.0.1` with a per-launch token; the token dies with the process. Treat the URL as a secret while it runs — it can write your `.hwf` files.

## Next

- [Examples](/examples) — recipes from trivial to agent handoffs.
- [Reference](/reference) — CLI flags, picker keys, load rules, ceilings.
