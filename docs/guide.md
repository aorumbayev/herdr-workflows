# Guide

Linear path from install to writing your own workflows. Contract tables live in the [Reference](/reference).

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

Writes `.hwf/config.yaml` with native Herdr profiles for agent kinds found on your PATH. No workflows yet — import ready-made ones from [Examples](/examples). Each card copies `hwf workflow import "<base64>"`; import prints the YAML, flags sensitive bits, asks before writing to this repo's `.hwf/workflows` or global `~/.hwf/workflows`.

Workflow YAML is reviewed executable code. Opening a repository never runs a workflow. There is no sandbox — a trusted `run:` can invoke the whole Herdr CLI or socket as your user.

## Run your first workflow

```yaml
# .hwf/workflows/scratch.yaml
version: v1alpha1
steps:
  - run: [lazygit]
    pane:
      open: tab
    background: true
```

- `prefix+k` → type `scratch` → enter
- From a terminal: `hwf run scratch`
- Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global); repo shadows global on the same name

Minimal document:

```yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

## Pick a surface

| Where                     | Use it for                                        |
| ------------------------- | ------------------------------------------------- |
| `prefix+k` (picker)       | running — collects entry inputs, then fires       |
| `hwf run <name>`          | running from scripts/terminal, with `--input k=v` |
| `hwf web` (or bare `hwf`) | editing — build, validate, share, browse run log  |

Running always goes through the picker or `hwf run`. The workbench builds and shares but never executes.

## Format

Every workflow declares `version: v1alpha1`. The package stays semver `0.x`; a later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a Herdr version — the plugin manifest and CLI own that.

Optional `title` and `description` appear in the picker (title defaults from the humanized filename). `hidden: true` hides a workflow from the picker but still allows `hwf run`.

## Four actions

Exactly one action key per step:

| Action      | Role                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `run:`      | local argv or shell command → `{stdout, stderr, exit_code, failed}`    |
| `agent:`    | managed native agent turn → `{response, agent, pane_id}` when blocking |
| `herdr:`    | explicit socket method + `params:` → that method's structured result   |
| `workflow:` | isolated child workflow with its own inputs and optional `returns:`    |

Templates use `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}` only. Results are automatic — there is no `out:` binding.

Config is only `profiles` / `default_profile` / `transcripts`. Example:

```yaml
# .hwf/config.yaml
profiles:
  claude:
    kind: claude
  deep:
    kind: claude
    args: ["--model", "opus"]
default_profile: claude
```

## Agent skill

To author workflows with an agent, install `skills/herdr-workflow-create` (see the [README](https://github.com/aorumbayev/herdr-workflows#agent-skill) for the paste-in prompt):

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Next

- [Examples](/examples) — import ready-made workflows
- [Reference](/reference) — panes, readiness, inputs, control flow, caps, trust, denylist
