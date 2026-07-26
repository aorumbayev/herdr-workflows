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
  - run: lazygit
    in: tab
```

- `prefix+k` → type `scratch` → enter. Done.
- Same thing from a terminal: `hwf run scratch` (live step output — best for debugging).
- Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global, every project). Repo shadows global on the same name.

One-liner floor:

```yaml
steps: bun test
```

## Pick a surface

| Where                     | Use it for                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `prefix+k` (picker)       | running — collects inputs and a prompt line, then fires        |
| `hwf run <name>`          | running from scripts/terminal, with `--input k=v` / `--prompt` |
| `hwf web` (or bare `hwf`) | editing — browser workbench: build, validate, share, run log   |

The web workbench never runs workflows — running needs real herdr panes. It shows you the `hwf run <name>` line to paste instead.

## Action keys

Exactly one per step. Steps run top to bottom.

- `run:` — command. Shape decides shell involvement: scalar/block go through `shell:` (default `sh`, no placeholders); argv list is shell-free and accepts `{name}` per argument.
- `agent:` — configured agent in a pane. Waits by default; `wait: false` detaches.
- `use:` — include another workflow; pass params with `with:`.
- `pane.split:` / `worktree.create:` / … — any allowed herdr method, spelled as herdr spells it.

Placement is a modifier: `in: here | tab | right | down` (defaults: `here` for `run:`, `tab` for `agent:`).

## Agents

An agent is a named CLI in `.hwf/config.yaml`. `hwf init` detects `claude` / `codex` on your PATH and writes them for you:

```yaml
agents:
  claude: [claude, "{prompt}"]
```

The one literal `{prompt}` element is where the step's `prompt:` text lands. `agent: claude` then opens that command in a pane and waits for it to finish; `out:` captures its final message.

## Placeholders

One flat namespace: `{branch}`, `{diff}`, `{session}`, builtins. **Not** `{input.branch}` or `{last}`.

Scalar/block `run:` reject placeholders — pass values as `HWF_<name>` env, or use argv form:

```yaml
# ✗ load error                         # ✓
- run: git checkout {branch}           - run: [git, checkout, "{branch}"]
```

`{session}` is legal in prompts, argv, and primitive params (no more `run: cat` hop).

## Inputs

```yaml
inputs:
  branch: sh git branch --format='%(refname:short)'
  focus: text = ""
steps:
  - agent: claude
    prompt: "Branch {branch}\nFocus: {focus}\n\n{pane}"
```

Shorthands: `text`, `text = …`, `[a, b] = a`, `sh <cmd>`, `agents`. Map form still has `label` / `desc`.

## Control flow

Skip with `when:`, loop with `for:` / `as:`, retry with `retry:` (pane-creating steps need `reset:`), soft-fail with `allow_fail:`, recover with `on_error:`.

```yaml
steps:
  - run: git diff HEAD
    out: diff
  - agent: claude
    when: "{diff}"
    prompt: "Review:\n{diff}"
```

## Composition

```yaml
# gate.yaml
inputs:
  suite: [unit, all] = unit
steps:
  - run: [bun, test, "--", "{suite}"]

# ship.yaml
on_error: continue
steps:
  - use: gate
    with: { suite: all }
  - run: git push
```

## Web workbench

```bash
hwf web   # opens http://127.0.0.1:7317/?token=… — or just run bare `hwf`
```

Text editor with live validation, or visual mode (drag-reorderable step cards). Bound to `127.0.0.1` with a per-launch token.

## Let an agent write it

`herdr-workflow-create` is an agent skill that interviews you, then validates the YAML against this plugin's own loader before writing the file:

```bash
npx skills add aorumbayev/herdr-workflows --skill herdr-workflow-create --global
```

## Coming from v1

v1 files fail to load, with errors naming the v2 spelling. There is no migrate command — the [key map](/reference#v1-to-v2-keys) is a short rename table.

## Next

- [Examples](/examples) — guarded review, fix-until-green, per-file loop, review workspace.
- [Reference](/reference) — every key, deny table, ceilings.
