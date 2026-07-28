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

Writes `.hwf/config.yaml`, probing your PATH for the agent kinds it knows (`claude`, `codex`, `aider`, `cursor`, `opencode`) and writing one profile per kind found, with the first as `default_profile`. It also creates `.hwf/workflows/` and gitignores `.hwf/config.local.yaml`.

### Profiles

A profile is the name a workflow's `using:` refers to — not an agent binary. `kind` is the native Herdr agent kind; live `agent.start` decides whether it is supported. Optional `args` pin startup flags, so one kind can back several roles:

```yaml
# .hwf/config.yaml
profiles:
  claude:
    kind: claude
  deep-review:
    kind: claude
    args: ["--model", "opus"]
default_profile: claude
```

`hwf init` gets you the plain one-profile-per-kind form; role names and `args` are yours to add. An `agent:` step with no `using:` and no `target:` uses `default_profile`.

Config merges across three layers, each replacing whole entries by name: the global plugin config dir (`hwf` finds it through Herdr), committed `.hwf/config.yaml`, then gitignored `.hwf/config.local.yaml` for per-machine choices — point `deep-review` at a different kind locally without touching what the team shares.

No workflows yet — import ready-made ones from [Examples](/examples). Each card copies `hwf workflow import "<base64>"`; import prints the YAML, flags sensitive bits, asks before writing to this repo's `.hwf/workflows` or global `~/.hwf/workflows`.

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

Config is only `profiles` / `default_profile` / `transcripts` — see [Profiles](#profiles) for the shape and [Reference](/reference#config) for transcript extractors.

## Agent skill

To author workflows with an agent, install `skills/herdr-workflow-create` (see the [README](https://github.com/aorumbayev/herdr-workflows#agent-skill) for the paste-in prompt):

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Next

- [Examples](/examples) — import ready-made workflows
- [Reference](/reference) — panes, readiness, inputs, control flow, caps, trust, denylist
