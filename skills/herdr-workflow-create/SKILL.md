---
name: herdr-workflow-create
description: Interactive wizard that turns a described task into a valid herdr-workflows YAML file at .hwf/workflows/<name>.yaml, then validates it against the real loader before writing. Covers syntax v2 action keys (run, agent, use, dotted herdr methods), inputs, placeholders, guards, loops, retry, recovery, and the herdr plugin API allowlist. Use when the user wants to automate a task in herdr, asks to create/edit/debug an hwf workflow or .hwf YAML, mentions herdr-workflows, hwf run, the prefix+k picker, or hits a workflow load error.
---

# Create a herdr-workflows workflow

Produces one YAML file that `hwf` (≡ `herdr-workflows`, a herdr plugin) runs as a linear
sequence of steps. Everything needed is in this skill — do not read the plugin source.

Where files go:

| Path                           | Scope                                          |
| ------------------------------ | ---------------------------------------------- |
| `.hwf/workflows/<name>.yaml`   | repo workflow (shadows global on same name)    |
| `~/.hwf/workflows/<name>.yaml` | global workflow (every project)                |
| `.hwf/config.yaml`             | `agents:` argv templates, optional `sessions:` |

`<name>`: lowercase, `[a-z0-9][a-z0-9-_]*`. How the user runs it afterwards: `prefix+k`
(picker), `hwf run <name> [--input k=v] [--prompt …]`, or `hwf web` to edit.

## Workflow

Copy this checklist and tick as you go:

```
- [ ] 1. Interview: goal, inputs, agent vs shell, placement, failure policy
- [ ] 2. Survey: read config agents + existing workflows
- [ ] 3. Compose the YAML
- [ ] 4. Validate through the real loader (MUST be ok:true)
- [ ] 5. Write the file, print the run command
```

### 1. Interview

Ask with one batched `AskUserQuestion` round (skip any question the request already answers):

- **Scope** — repo (`.hwf/workflows/`) or global (`~/.hwf/workflows/`)?
- **Shape** — shell commands only / one agent with a prompt / agent + shell context / herdr
  layout (panes, tabs, worktrees)?
- **Inputs** — what should the picker ask for each run? (branch, focus text, target agent, none)
- **Failure policy** — stop on first failure (default) / keep going (`allow_fail:`) /
  run a recovery step (`on_error:`) / retry (`retry:`)?

Ask about placement (`in:`) only when panes matter. Prefer one working step over a
speculative pipeline — a workflow is cheap to extend later.

### 2. Survey

```bash
cat .hwf/config.yaml ~/.hwf/config.yaml 2>/dev/null   # agent names usable in agent:
ls .hwf/workflows ~/.hwf/workflows 2>/dev/null        # reusable targets for use:
```

`agent:` values must be keys under `agents:`. No config yet → tell the user to run
`hwf init` first (it detects claude/codex/aider/cursor on PATH and seeds a `review`
workflow). Existing workflow that already does a sub-task → compose with `use:` + `with:`
instead of duplicating steps.

### 3. Compose

The shape that covers most requests:

```yaml
desc: one line shown in the picker
inputs:
  branch: sh git branch --format='%(refname:short)'
  focus: text = ""
steps:
  - run: git diff HEAD
    out: diff
  - agent: claude
    when: "{diff}"
    timeout: 900
    prompt: |
      Branch {branch}, focus: {focus}

      {diff}
```

Floor case, one command: `steps: bun test`.

Exactly one action key per step, top to bottom, foreground:

| Action        | Value                      | Notes                                           |
| ------------- | -------------------------- | ----------------------------------------------- |
| `run`         | scalar / argv list / block | local subprocess, or a placed pane with `in:`   |
| `agent`       | config agent name          | pane + `prompt:`, waits for the agent to finish |
| `use`         | workflow name              | inline another workflow, params via `with:`     |
| `method.name` | params object              | any allowed herdr method, e.g. `pane.split:`    |

Modifiers (only these keys): `name in ratio cwd shell env out with when for as retry wait
timeout allow_fail on_error prompt`.

Full key semantics, every load-error message, and the placeholder rules:
**[reference/syntax.md](reference/syntax.md)**.
herdr methods, their params, denials, and `out:` dot-paths:
**[reference/herdr-api.md](reference/herdr-api.md)**.
Validated copy-paste recipes (review gate, worktree, handoff, fix-until-green, per-file
loop, review workspace, notify):
**[reference/recipes.md](reference/recipes.md)**.

### 4. Validate — mandatory gate

Never write a workflow you have not validated. The bundled script runs the plugin's own
loader, so its errors are exactly what `hwf run` would print:

```bash
sh skills/herdr-workflow-create/scripts/validate.sh /tmp/draft.yaml <name>
```

Prints `{"ok":true}` (exit 0) or `{"ok":false,"error":"<file>, step N, key: message"}`
(exit 1). Draft to a temp file, validate, fix, repeat until it passes. Needs `hwf` on
PATH, `curl`, `python3`; it starts a localhost `hwf web` server and stops it on exit.

If `hwf` is not installed, say so and hand-check every rule in
[reference/syntax.md](reference/syntax.md) instead — do not claim the file is valid.

### 5. Write and report

Write the validated YAML to the chosen scope, then print:

```
hwf run <name> [--input k=v …] [--prompt "…"]     # or prefix+k → <name>
```

Add the editor schema line at the top only if the user wants IDE completion:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json
```

## Rules that break workflows

These are the load failures that actually happen. Each is a hard error, not a warning.

1. **No placeholders in scalar/block `run:`.** `run: git checkout {branch}` fails. Use argv
   form `run: [git, checkout, "{branch}"]`, or read `$HWF_branch` in the command text.
2. **Every declared input must be referenced**, or the load fails with
   `declared but never referenced`. `$HWF_<name>` inside shell text counts.
3. **Loop bindings are step-scoped.** `{item}` / `{index}` (and an `as:` alias) resolve only
   inside the looping step — referencing them anywhere else is `unknown name`.
4. **`retry.reset:` is a shell command string**, not a step list. `retry:` on a
   pane-creating step (`agent:`, or `run:` with `in:` other than `here`) _requires_
   `reset:` — otherwise attempt 2 strands attempt 1's pane.
5. **`out:` form follows the step**: identifier for `run` with `in: here` (stdout) and for
   `agent` (final pane text); map form (`out: { p: pane_id }`) for primitives and placed
   `run`. Bare `tab_id` is not a valid path — use `layout.tab_id`.
6. **`out:`/`as:` names cannot shadow a builtin** (`pane`, `prompt`, `item`, …) or collide
   with an input.
7. **`wait: /regex/` needs a placed step** (`in: tab|right|down`). `wait: false` (detached)
   cannot bind `out:`.
8. **`on_error:` takes a workflow name or an inline step list** — not a keyword. A recovery
   workflow may not declare `inputs:` or its own `on_error:`.
9. **`{session}` / `{session_file}`** require launching from an agent pane, and are
   rejected in scalar/block `run:` under rule 1. `{agent}` (the invoking agent) must exist
   in `agents:`.

Out of scope by design: parallel steps, Windows, nested loops beyond one level, any
external engine (no Dagu/Taskfile). `for:` caps at 100 items. Needs herdr ≥ 0.7.5.

## Keywords

herdr workflow, herdr-workflows, hwf, .hwf/workflows, workflow yaml, syntax v2, hwf run,
prefix+k picker, herdr plugin api, pane.split, worktree.create, agent handoff, workflow
load error
