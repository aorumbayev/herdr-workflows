---
name: herdr-workflow-create
description: Creates or edits a herdr-workflows v1alpha1 YAML under .hwf/workflows/ and validates it through the real loader. Use when the user asks to create, edit, or debug an hwf / herdr-workflows workflow YAML or hits a workflow load error.
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

`<name>`: lowercase, `[a-z0-9][a-z0-9-_]*` (hyphens allowed). Step `id:` is a _different_,
stricter rule — see Rules. Run with `prefix+k`, `hwf run <name> [--input k=v]`, or `hwf web`.

## Workflow

```
- [ ] 1. Interview: goal, inputs, agent vs shell, placement, failure policy
- [ ] 2. Survey: read profiles + existing workflows
- [ ] 3. Start the workbench in the background, hand the user the live canvas link
- [ ] 4. Compose v1alpha1 YAML only
- [ ] 5. Validate through the real loader (MUST be ok:true)
- [ ] 6. Save, then keep iterating on the live canvas
```

### 1. Interview

Ask once in a single turn (skip answers already given). Prefer the host's structured
question UI when available; otherwise ask conversationally:

- **Scope** — repo (`.hwf/workflows/`) or global (`~/.hwf/workflows/`)?
- **Shape** — shell only / managed agent / agent + shell / explicit Herdr layout?
- **Inputs** — what should the picker ask? (`text`, `choice`, `profile`)
- **Failure policy** — stop (default) / `continue_on_error` / entry `on_failure` / `retry` on local run/herdr?

Workflow YAML is reviewed executable code. There is no sandbox. Prefer one working step over a
speculative pipeline.

### 2. Survey

Run from the project root:

```bash
cat .hwf/config.yaml .hwf/config.local.yaml 2>/dev/null
ls .hwf/workflows ~/.hwf/workflows 2>/dev/null
```

`using:` values must be merged profile names. No config yet → `hwf init` first. Reuse work with
`workflow:` + `inputs:` instead of duplicating steps.

`herdr:` methods and their required selectors are listed in
**[reference/herdr-api.md](reference/herdr-api.md)** — that list is complete, so use it and move on.
This skill is installed outside the herdr-workflows checkout, so its `src/` and `schemas/` are
**not readable**; do not try to read them. Only if a method is absent from that table, query the
workbench started in step 3 (`GET /api/methods` with the `x-hwf-token` header) for its `allowed`
flag and param schema.

### 3. Open the live canvas (background)

Start the workbench once and keep it running while you compose:

```bash
hwf web --no-open > /tmp/hwf-web.log 2>&1 &
# wait until the log prints: herdr-workflows web · http://127.0.0.1:<port>/?token=…
```

Send `<url>#w=repo:<name>` (or `#w=global:<name>`) and tell them to press **canvas**. Do not
block the interview/compose loop on the browser.

### 4. Compose

```yaml
version: v1alpha1
title: Review diff
description: Skip the agent when the tree is clean
inputs:
  focus:
    type: text
    description: What the review should concentrate on
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
Herdr methods + required selectors: **[reference/herdr-api.md](reference/herdr-api.md)**.
Recipes: **[reference/recipes.md](reference/recipes.md)**.

### 5. Validate — mandatory gate

Run it **from the project root** (the directory holding `.hwf/`), with an absolute path to the
script. The loader resolves `workflow:` children, `using:` profiles and dynamic `options: {run:}`
relative to the current directory, so validating from anywhere else — including this skill's own
install directory — reports false errors such as `workflow '<child>' not found`.

```bash
draft=$(mktemp -t hwf-draft.XXXXXX)   # unique path; never a shared /tmp/draft.yaml
# … write the YAML to "$draft" …
sh "<absolute path to this skill>/scripts/validate.sh" "$draft" <name>
```

Prints `{"ok":true}` or `{"ok":false,"error":…}`. Exit `0` = valid, `1` = the loader rejected it,
`2` = cannot check (missing `hwf`/`curl`/`python3`, or web failed). Draft → validate → fix until
pass. The error names the exact key and, for `herdr:` steps, the exact missing selector.

### 6. Save and iterate

Write validated YAML early so the canvas updates. Re-read the file before each edit — the user
may have saved from the browser.

```
hwf run <name> [--input k=v …]
```

Do **not** hand-write a `# yaml-language-server: $schema=…` line, and never point one at `main`:
the schema is published per release and a workbench save rewrites the pointer to this build's
version. If a file needs one before its first workbench save, pin the tag:
`…/herdr-workflows/v$(hwf --version)/docs/workflow.schema.json`.

## Rules that break workflows

1. **Step `id:` must match `[a-z][a-z0-9_]{0,31}`** — lowercase, starts with a letter, `_` only.
   Hyphens are rejected: `id: check-lint` fails to load, use `check_lint`. **Input names follow the
   same rule.** Workflow _file_ names use the looser `[a-z0-9][a-z0-9-_]*`; do not confuse the two.
2. **No templates in string `run:` text.** Use argv `run: [git, checkout, "{{inputs.branch}}"]` or `env:` / `$HWF_…`. Shell `$HWF_<conditional>` needs the step's matching `when:` guards.
3. **Every declared input must be referenced** — by a template, a later input's `when:`, `returns:`, `on_failure:`, or `$HWF_<name>` in shell text. Otherwise: `unused input`.
4. **`retry`** only on blocking local `run:` or `herdr:` — never on a placed, background or `on_failure` step.
5. **`target:`** requires an existing idle/done agent; rejects `pane:`, `cwd:`, `env:` and `using:`. Warn the user if the invoking pane may still be busy.
6. **A `run:` step with `pane:` must set exactly one of `background: true` or `ready_when:`** — a bare placed run fails to load. `background:` also rejects `timeout:`, `retry:` and `pane.close`.
7. **`pane.size` and `pane.target` are valid only for `open: beside`/`below`**; `pane.workspace` only for `open: tab`. A tab has no size, so "a tab at 40%" must become `open: beside, size: 40` — say so instead of silently dropping the size.
8. **`ready_when`** is a `/regex/` with **no flags**, requires `timeout:`, scrapes the recent 80 rows, does not detect process exit, and rejects `retry:`.
9. **`herdr:` steps need that method's exact selector** (table in reference/herdr-api.md). Nothing is autofilled from live UI focus; a template on an unrelated param does not waive it; for an `exactly one of` method, passing _both_ selectors also fails.
10. **`on_failure`** is entry-only, one action, once. `{{context.error.*}}` (`message`, `workflow`, `action`, `step_id`) exists only there.
11. **Denied Herdr methods fail at load** — the allowlist is a misuse rail, not a sandbox.
12. **`when:`** lists are ordered AND; they reject structured sources (use a scalar field). `allow_custom` only on choices. A closed choice's `default:` must be one of its `options:`.
13. **No `out:`, `wait:`, `in:`, `use:`, `with:`, `for:`/`as:`, `allow_fail`, `on_error`, dotted method keys, flat `{name}`.**
14. **Transcript / identity context** unavailable → preflight failure.

Out of scope: parallelism, loops, external engines. OS branching uses `{{context.platform}}` + `when:`. Windows runs through WSL2. Needs herdr ≥ 0.7.5.
