---
name: herdr-workflow-create
description: Interactive wizard that turns a described task into a valid herdr-workflows v1alpha1 YAML file at .hwf/workflows/<name>.yaml, then validates it against the real loader before writing. Covers agent/run/herdr/workflow actions, templates, panes, recovery, and trust. Use when the user wants to automate a task in herdr, asks to create/edit/debug an hwf workflow or .hwf YAML, mentions herdr-workflows, hwf run, the prefix+k picker, or hits a workflow load error.
---

# Create a herdr-workflows workflow

Produces one YAML file that `hwf` (≡ `herdr-workflows`, a herdr plugin) runs as a linear
sequence of steps. Format is `version: v1alpha1`. Everything needed is in this skill — do
not invent legacy keys (`out:`, `wait:`, `use:`, dotted method actions, `{name}` placeholders).

Where files go:

| Path                           | Scope                                          |
| ------------------------------ | ---------------------------------------------- |
| `.hwf/workflows/<name>.yaml`   | repo workflow (shadows global on same name)    |
| `~/.hwf/workflows/<name>.yaml` | global workflow (every project)                |
| `.hwf/config.yaml`             | `profiles` / `default_profile` / `transcripts` |
| `.hwf/config.local.yaml`       | gitignored whole-entry overrides               |

`<name>`: lowercase, `[a-z0-9][a-z0-9-_]*`. Run with `prefix+k`, `hwf run <name> [--input k=v]`,
or edit in `hwf web`.

## Workflow

```
- [ ] 1. Interview: goal, inputs, agent vs shell, placement, failure policy
- [ ] 2. Survey: read profiles + existing workflows
- [ ] 3. Open the workbench, hand the user the live canvas link
- [ ] 4. Compose v1alpha1 YAML only
- [ ] 5. Validate through the real loader (MUST be ok:true)
- [ ] 6. Save, then keep iterating on the live canvas
```

### 1. Interview

Ask with one batched `AskUserQuestion` round (skip answers already given):

- **Scope** — repo (`.hwf/workflows/`) or global (`~/.hwf/workflows/`)?
- **Shape** — shell only / managed agent / agent + shell / explicit Herdr layout?
- **Inputs** — what should the picker ask? (`text`, `choice`, `profile`)
- **Failure policy** — stop (default) / `continue_on_error` / entry `on_failure` / `retry` on local run/herdr?

Workflow YAML is reviewed executable code. There is no sandbox. Prefer one working step over a
speculative pipeline.

### 2. Survey

```bash
cat .hwf/config.yaml .hwf/config.local.yaml 2>/dev/null
ls .hwf/workflows ~/.hwf/workflows 2>/dev/null
```

`using:` values must be merged profile names. No config yet → `hwf init` first. Reuse work with
`workflow:` + `inputs:` instead of duplicating steps.

### 3. Open the live canvas

```bash
hwf web --no-open        # prints: herdr-workflows web · http://127.0.0.1:7317/?token=…
```

Send `<url>#w=repo:<name>` (or `#w=global:<name>`) and tell them to press **canvas**.

### 4. Compose

```yaml
version: v1alpha1
title: Review diff
description: Skip the agent when the tree is clean
inputs:
  focus:
    type: text
    default: ""
steps:
  - id: diff
    run: [git, diff, HEAD]
  - agent: |
      Focus: {{inputs.focus}}

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    pane:
      open: beside
```

Exactly one action per step: `run` | `agent` | `herdr` | `workflow`.

Templates: `{{inputs.*}}` / `{{steps.*}}` / `{{context.*}}` only. Results are automatic.

Full syntax: **[reference/syntax.md](reference/syntax.md)**.
Herdr allowlist notes: **[reference/herdr-api.md](reference/herdr-api.md)**.
Recipes: **[reference/recipes.md](reference/recipes.md)**.

### 5. Validate — mandatory gate

```bash
sh skills/herdr-workflow-create/scripts/validate.sh /tmp/draft.yaml <name>
```

Prints `{"ok":true}` or `{"ok":false,"error":…}`. Draft → validate → fix until pass.

### 6. Save and iterate

Write validated YAML early so the canvas updates. Re-read the file before each edit — the user
may have saved from the browser.

```
hwf run <name> [--input k=v …]
```

Optional IDE schema line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json
```

## Rules that break workflows

1. **No templates in string `run:` text.** Use argv `run: [git, checkout, "{{inputs.branch}}"]` or `env:` / `$HWF_…`.
2. **Every declared input must be referenced** (templates or `$HWF_<name>` in shell text).
3. **No `out:`, `wait:`, `in:`, `use:`, `with:`, `for:`/`as:`, `allow_fail`, `on_error`, dotted method keys, flat `{name}`.**
4. **`retry`** only on blocking local `run:` or `herdr:`.
5. **`target:`** requires idle/done; rejects pane/cwd/env.
6. **`background: true`** needs a Herdr-owned pane or existing-agent `target:`.
7. **`ready_when`** needs `timeout`; scrapes recent 80 rows; does not detect process exit.
8. **`on_failure`** is entry-only, one action, once.
9. **Transcript / identity context** unavailable → preflight failure.
10. **Denied Herdr methods** fail at load — denylist is a misuse rail, not a sandbox.

Out of scope: parallelism, loops, external engines. Windows via `{{context.platform}}` + `when:`. Needs herdr ≥ 0.7.5.

## Keywords

herdr workflow, herdr-workflows, hwf, v1alpha1, .hwf/workflows, hwf run, hwf web, prefix+k,
managed agent, pane, transcript, workflow load error
