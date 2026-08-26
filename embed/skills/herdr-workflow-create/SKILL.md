---
name: herdr-workflow-create
description: Creates or edits a herdr-workflows v1alpha1 YAML under .hwf/workflows/ and validates it through the real loader. Use when the user asks to create, edit, or debug an hwf / herdr-workflows workflow YAML or hits a workflow load error.
---

# Create a herdr-workflows workflow

Write one YAML file. `hwf` (same as `herdr-workflows`) runs that file as a linear sequence of steps.
Format is `version: v1alpha1`. This skill and its reference files are complete. A key that is not in these files does not exist in v1alpha1 (rule 13 lists usual inventions).

| Path | Scope |
| --- | --- |
| `.hwf/workflows/<name>.yaml` | repo workflow (this name shadows the global file) |
| `~/.hwf/workflows/<name>.yaml` | global workflow (every project) |
| `.hwf/config.yaml` | `profiles` / `default_profile` / `transcripts` |
| `.hwf/config.local.yaml` | gitignored whole-entry overrides |

`<name>`: lowercase, `[a-z0-9][a-z0-9-_]*` (hyphens are valid). Step `id:` and input names use a stricter rule. Refer to Load rules. Edit in `$EDITOR` (picker `Ctrl+P`, then `n` or `o`) or any text editor. Run with `prefix+k` or `hwf run <name> [--input k=v]`.

## Procedure

```
- [ ] 1. Interview: goal, inputs, agent vs shell, placement, failure policy
- [ ] 2. Survey: read profiles and existing workflows
- [ ] 3. Compose v1alpha1 YAML only
- [ ] 4. Validate through the real loader (MUST be ok:true)
- [ ] 5. Save, then iterate
```

### 1. Interview

Ask once in a single turn. Skip answers that the user already gave. Prefer the host structured-question UI. If that UI is absent, ask in conversation:

- **Scope** — repo (`.hwf/workflows/`) or global (`~/.hwf/workflows/`)?
- **Shape** — shell only / managed agent / agent + shell / explicit Herdr layout?
- **Inputs** — what must the picker ask? (`text`, `choice`, `profile`)
- **Failure policy** — stop (default) / `continue_on_error` / entry `on_failure` / `retry` on local `run:` or `herdr:`?

Workflow YAML is reviewed executable code. There is no sandbox. Prefer one step that works over a speculative pipeline.

### 2. Survey

From the project root:

```bash
cat .hwf/config.yaml .hwf/config.local.yaml 2>/dev/null
ls .hwf/workflows ~/.hwf/workflows 2>/dev/null
```

`using:` values must be merged profile names. If there is no config, run `hwf init` first. Reuse work with `workflow:` + `inputs:`. Do not duplicate child steps.

**[reference/herdr-api.md](reference/herdr-api.md)** lists every `herdr:` method and the selector that it requires. That list is complete. Use it. This skill lives outside the herdr-workflows checkout, so `src/` and `schemas/` are **not readable**.

### 3. Compose

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
Herdr methods and required selectors: **[reference/herdr-api.md](reference/herdr-api.md)**.
Recipes: **[reference/recipes.md](reference/recipes.md)**.

### 4. Validate — mandatory gate

Run the check **from the project root** (the directory that holds `.hwf/`). Use an absolute path to the script. The loader resolves `workflow:` children and `using:` profiles from the current directory. The loader validates dynamic `options: {run:}` declarations. It does not run discovery. A check from this skill install directory can report false errors such as `workflow '<child>' not found`.

```bash
draft=$(mktemp -t hwf-draft.XXXXXX)
# write the YAML to "$draft"
sh "<absolute path to this skill>/scripts/validate.sh" "$draft" <name>
```

Prints `{"ok":true}` or `{"ok":false,"error":…}`. Exit `0` = valid. Exit `1` = the loader rejected the file. Exit `2` = cannot check (missing `hwf`). Draft, then validate, then fix until the check passes. The error names the exact key. For `herdr:` steps it names the missing selector. Prefer `hwf workflow validate <file> [name]` when you call the CLI.

### 5. Save and iterate

Write validated YAML early. Read the file again before each edit.

```
hwf run <name> [--input k=v …]
```

Do **not** write a `# yaml-language-server: $schema=…` line that points at `main`. When a pointer is required, pin the release tag:
`…/herdr-workflows/v$(hwf --version)/docs/workflow.schema.json`.
Picker `n` stubs already carry this build schema pointer.

## Load rules

1. **Step `id:` must match `[a-z][a-z0-9_]{0,31}`** — lowercase, first character a letter, `_` only.
   The loader rejects hyphens: `id: check-lint` fails. Use `check_lint`. **Input names use the same rule.**
   Workflow file names use `[a-z0-9][a-z0-9-_]*`. Do not mix the two rules.
2. **No templates in string `run:` text.** Use argv `run: [git, checkout, "{{inputs.branch}}"]` or `env:` / `$HWF_…`. Shell `$HWF_<conditional>` needs the step `when:` guards to match.
3. **Reference every declared input** — by a template, a later input `when:`, `returns:`, `on_failure:`, or `$HWF_<name>` in shell text. Else: `unused input`.
4. **`retry`** only on blocking local `run:` or `herdr:`. Never on a placed, background, or `on_failure` step.
5. **`target:`** requires an existing idle or done agent. It rejects `pane:`, `cwd:`, `env:`, and `using:`. Warn the user if the pane that starts the workflow can still be busy.
6. **A `run:` step with `pane:` must set exactly one of `background: true` or `ready_when:`.** A bare placed run fails to load. `background:` also rejects `timeout:`, `retry:`, and `pane.close`.
7. **`pane.size` and `pane.target` are valid only for `open: beside`/`below`.** `pane.workspace` is valid only for `open: tab`. A tab has no size. "A tab at 40%" must become `open: beside, size: 40`. Tell the user. Do not drop the size.
8. **`ready_when`** is a `/regex/` with **no flags**. It requires `timeout:`. It scrapes the recent 80 rows. It does not detect process exit. It rejects `retry:`.
9. **`herdr:` steps need that method exact selector** (table in reference/herdr-api.md). The runner does not fill targets from live UI focus. A template on an unrelated param does not waive it. For an `exactly one of` method, both selectors together also fail to load.
10. **`on_failure`** is entry-only, one action, once. `{{context.error.*}}` has `message`, `workflow`, `action`, `step_number`, `workflow_path`, `details`, and optional `step_id`, only there.
11. **Denied Herdr methods fail at load.** The allowlist is a misuse rail, not a sandbox.
12. **`when:`** lists are ordered AND. They reject structured sources (use a scalar field). `allow_custom` only on choices. A closed choice `default:` must be one of its `options:`.
13. **No `out:`, `wait:`, `in:`, `use:`, `with:`, `for:`/`as:`, `allow_fail`, `on_error`, dotted method keys, flat `{name}`.**
14. **Transcript / identity context** unavailable → preflight failure.

Out of scope: parallelism, loops, external engines. OS branches use `{{context.platform}}` + `when:`. Windows runs through WSL2. Needs herdr ≥ 0.8.2.
