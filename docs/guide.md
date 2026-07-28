# Guide

Linear path from install to writing your own workflows. Contract tables live in the [Reference](/reference).

## Install

Needs [herdr](https://herdr.dev) ≥ 0.7.5.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

That compiles the plugin, puts `hwf` (≡ `herdr-workflows`) on your PATH, and binds `prefix+k` to the picker.

## Set up profiles

```bash
cd your-repo
hwf init            # team / repo-local: .hwf/config.yaml
# or
hwf init --global   # personal: Herdr plugin config dir (for ~/.hwf/workflows)
```

Both probe PATH for the agent kinds they know (`claude`, `codex`, `aider`, `cursor`, `opencode`) and write one profile per kind found, with the first as `default_profile`. Repo init also creates `.hwf/workflows/` and gitignores `.hwf/config.local.yaml`. Use repo init when the team shares profiles in git; use `--global` when you keep workflows in `~/.hwf/workflows` and want profiles without touching each checkout.

### Profiles

A profile is the name a workflow's `using:` refers to — not an agent binary. `kind` is the native Herdr agent kind; live `agent.start` decides whether it is supported. Optional `args` pin startup flags, so one kind can back several roles:

```yaml
# .hwf/config.yaml  (or the global plugin config.yaml)
profiles:
  claude:
    kind: claude
  deep-review:
    kind: claude
    args: ["--model", "opus"]
default_profile: claude
```

`hwf init` gets you the plain one-profile-per-kind form; role names and `args` are yours to add. An `agent:` step with no `using:` and no `target:` uses `default_profile`.

Config merges across three layers, each replacing whole entries by name: the global plugin config dir (`$HERDR_PLUGIN_CONFIG_DIR/config.yaml`, discovered via `herdr plugin config-dir`), committed `.hwf/config.yaml`, then gitignored `.hwf/config.local.yaml` for per-machine choices — point `deep-review` at a different kind locally without touching what the team shares.

No workflows yet — import ready-made ones from [Examples](/examples). Each card copies `hwf workflow import "<bundle>"`. Import reviews every bundled YAML, flags sensitive bits, asks for one repo or global destination, and confirms before writing. Name conflicts are handled per surface — see [Share and import](#share-and-import).

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

| Where                     | Use it for                                                    |
| ------------------------- | ------------------------------------------------------------- |
| `prefix+k` (picker)       | run; list-mode `Ctrl+E` edit, `Ctrl+Y` share, `Ctrl+O` import |
| `hwf run <name>`          | run from scripts/terminal, with `--input k=v`                 |
| `hwf web` (or bare `hwf`) | edit, share, import review, browse run log — never executes   |

Running always goes through the picker or `hwf run`. The workbench builds, shares, and imports but never executes. Picker shortcuts and `hwf web` reuse one live authenticated workbench per repository when the recorded endpoint still answers.

### Picker workbench shortcuts

In list mode (filter focused):

- `Ctrl+E` — open the selected workflow in the editor (`#w=<source>:<name>`)
- `Ctrl+Y` — share the selected workflow and connected children (`#share=<source>:<name>`)
- `Ctrl+O` — open import review (`#import`); no selection required

Edit and share keep exact repo/global provenance. With no valid selection they are no-ops. Printable `e` / `y` / `o` still enter the filter. The picker dismisses only after a successful detached handoff.

### Share and import

Share produces the canonical command:

```bash
hwf workflow import "<bundle>"
```

The bundle is gzip+base64 of a non-empty `{name, yaml}[]` array: the exact selected source plus every transitively referenced `workflow:` child, resolved repo-first then global (same as runtime). Local provenance is display-only and is not encoded. Cycles or missing children fail export. The removed single-workflow `{v, name, body}` payload is unsupported — re-export.

Import (CLI or workbench `#import`) accepts that command or the raw encoded bundle, never other shell text. It shows every YAML body and aggregate sensitivity warnings, requires one `repo` or `global` destination for the whole set, then confirmation. If any bundled name already exists in that scope, nothing is written: the workbench asks for an explicit replace-all confirmation; the CLI reports the conflicts and requires a rerun with `--force`. Share and import never run workflows.

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
