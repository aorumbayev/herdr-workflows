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

Writes `.hwf/config.yaml` — the agents found on your PATH. No workflows: pick the ones you want from [Examples](/examples), where each card copies a `hwf workflow import "<base64>"` command. The command prints the YAML, asks whether you reviewed it, then asks for this repo's `.hwf/workflows` or your global `~/.hwf/workflows`.

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
- `agent:` — configured agent in a pane. Waits by default; `wait: false` detaches; `close: true` reaps the pane when the wait ends.
- `use:` — include another workflow; pass params with `with:`.
- `pane.split:` / `worktree.create:` / … — any allowed herdr method, spelled as herdr spells it.

Placement is a modifier: `in: here | tab | right | down` (defaults: `here` for `run:`, `tab` for `agent:`).

## Agents

An agent is a named CLI in `.hwf/config.yaml`. `hwf init` detects `claude` / `codex` on your PATH and writes them for you:

```yaml
agents:
  claude: [claude, "{prompt}"]
```

`hwf init` writes `.hwf/config.yaml` from your PATH every time it runs, so treat it as machine-local. Agents you want on every machine belong in `~/.hwf/config.yaml`; keep the repo file for agents this project actually needs, since it wins per name.

The one literal `{prompt}` element is where the step's `prompt:` text lands. `agent: claude` then opens that command in a pane and waits for it to finish. With `out:`, the runner appends an instruction to write the final response to a temporary file; missing or empty output fails the step.

## Placeholders

One flat namespace: inputs, `out:` names, and builtins all read as `{name}` — `{branch}`, `{diff}`, `{session}`.

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

`when:` also compares strings — `{name} == "v"` / `!= "v"`. With the `{platform}` builtin (`macos` / `linux` / `windows`) that forks steps per OS:

```yaml
- run: [make, setup]
  when: '{platform} != "windows"'
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

## Background runs

`wait: false` on a local `run:` step is fire-and-forget: the child inherits your invoking environment (`{agent}`, `{source_tab}`, `{session_file}` still resolve inside it) and the step returns immediately. The supported pattern is an entry workflow whose last step spawns a `hidden: true` workflow — kept out of the picker, meant to be spawned:

```yaml
# ship.yaml — last step
- run: [hwf, run, ship-bg, --input, "branch={branch}"]
  wait: false

# ship-bg.yaml
hidden: true
inputs:
  branch: text
steps:
  - agent: claude
    focus: false   # don't steal focus
    close: true    # close the pane when done
    prompt: "Deploy {branch}. Report tersely."
```

## Web workbench

```bash
hwf web   # opens http://127.0.0.1:7317/?token=… — or just run bare `hwf`
```

Text editor with live validation, or visual mode (drag-reorderable step cards). Bound to `127.0.0.1` with a per-launch token.

`<url>#w=repo:<name>` (or `#w=global:<name>`) opens straight onto one workflow, and waits for it if the file does not exist yet. The open workflow reloads from disk every 1.5s, so a workflow being written by an agent — or by your editor — redraws on the canvas as it changes. Anything you have unsaved is left alone.

## Let an agent write it

`herdr-workflow-create` is an agent skill that interviews you, starts the workbench so you watch the canvas fill in, and validates every YAML against this plugin's own loader before saving. Paste this to your coding agent:

```
Install the herdr-workflows toolkit so you can build workflows for me:

1. If `hwf` is not on PATH: herdr plugin install aorumbayev/herdr-workflows
2. Install the skill for this agent:
   npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
3. Read the installed herdr-workflow-create/SKILL.md so you know the authoring workflow.
4. In this repo: run `hwf init` if .hwf/config.yaml is missing, then start the workbench in
   the background with `hwf web --no-open` and give me the URL it prints.
5. Build a small test workflow — one `run: git status --short` step — save it, send me
   <url>#w=repo:<name>, and confirm the canvas draws it. Then interview me for the real one.
```

Or install it by hand:

```bash
npx skills add aorumbayev/herdr-workflows --skill herdr-workflow-create --global
```

## Next

- [Examples](/examples) — guarded review, fix-until-green, per-file loop, review workspace.
- [Reference](/reference) — every key, deny table, ceilings.
