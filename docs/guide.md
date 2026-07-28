# Guide

This guide takes you from install to writing your own workflows. Contract tables live in the [Reference](/reference).

## Install

You need [herdr](https://herdr.dev) 0.7.5 or newer.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

The install compiles the plugin, then attempts to link `hwf` / `herdr-workflows` into `~/.local/bin` (or `$XDG_BIN_HOME`) and append a validated `prefix+k` picker binding. Both steps are nonfatal — skips print a note and continue. If needed: `command -v hwf`, `herdr config check`, and add the bin dir to PATH when the install warns it is missing.

## Set up profiles

```bash
cd your-repo
hwf init            # team / repo-local: .hwf/config.yaml
# or
hwf init --global   # personal: herdr plugin config dir (for ~/.hwf/workflows)
```

Both commands probe PATH for known agent kinds (`claude`, `codex`, `aider`, `cursor`, `opencode`). Each found kind becomes one profile. The first kind is `default_profile`.

Repo init also creates `.hwf/workflows/` and gitignores `.hwf/config.local.yaml`. Use repo init when the team shares profiles in git. Use `--global` when you keep workflows in `~/.hwf/workflows` and want profiles without a checkout change.

### Profiles

A profile is the name a workflow `using:` refers to. It is not an agent binary. `kind` is the native herdr agent kind. Live `agent.start` decides whether that kind is supported.

Optional `args` pin startup flags. One kind can then back several roles:

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

`hwf init` writes the plain one-profile-per-kind form. You add role names and `args`. An `agent:` step with no `using:` and no `target:` uses `default_profile`.

Config merges across three layers. Each layer replaces whole entries by name:

1. Global plugin config (`$HERDR_PLUGIN_CONFIG_DIR/config.yaml`, from `herdr plugin config-dir`)
2. Committed `.hwf/config.yaml`
3. Gitignored `.hwf/config.local.yaml` for per-machine choices

You can point `deep-review` at a different kind locally without changing what the team shares.

If you have no workflows yet, import ready-made ones from [Examples](/examples). Each card copies `hwf workflow import "<bundle>"`. Import reviews every bundled YAML, flags sensitive bits, asks for one repo or global destination, and confirms before it writes. Name conflicts are handled per surface. See [Share and import](#share-and-import).

Treat workflow YAML as reviewed executable code. Opening a repository never runs a workflow. There is no sandbox. A trusted `run:` can call the full herdr CLI or socket as your user.

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

1. Press `prefix+k`, type `scratch`, then press enter.
2. Or run `hwf run scratch` from a terminal.
3. Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global). A repo name shadows a global name.

Minimal document:

```yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

## Pick a surface

| Where                     | Use it for                                                    |
| ------------------------- | ------------------------------------------------------------- |
| `prefix+k` (picker)       | run. List-mode `Ctrl+E` edit, `Ctrl+Y` share, `Ctrl+O` import |
| `hwf run <name>`          | run from scripts/terminal, with `--input k=v`                 |
| `hwf web` (or bare `hwf`) | edit, share, import review, browse run log — never executes   |

Runs always go through the picker or `hwf run`. The workbench builds, shares, and imports. It never executes. Picker shortcuts and `hwf web` reuse one live authenticated workbench per repository when the recorded endpoint still answers.

### Picker workbench shortcuts

In list mode (filter focused):

- `Ctrl+E` — open the selected workflow in the editor (`#w=<source>:<name>`)
- `Ctrl+Y` — share the selected workflow and connected children (`#share=<source>:<name>`)
- `Ctrl+O` — open import review (`#import`). No selection required.

Edit and share keep exact repo or global provenance. With no valid selection they do nothing. Printable `e` / `y` / `o` still enter the filter. The picker dismisses only after a successful detached handoff.

### Share and import

Share produces the canonical command:

```bash
hwf workflow import "<bundle>"
```

The bundle is gzip+base64 of a non-empty `{name, yaml}[]` array. It holds the exact selected source plus every transitively referenced `workflow:` child. Resolution is repo-first, then global (same as runtime). Local provenance is display-only and is not encoded. Cycles or missing children fail export. The removed single-workflow `{v, name, body}` payload is unsupported. Re-export instead.

Import (CLI or workbench `#import`) accepts that command or the raw encoded bundle. It never accepts other shell text. It shows every YAML body and aggregate sensitivity warnings. It requires one `repo` or `global` destination for the whole set, then confirmation.

If any bundled name already exists in that scope, nothing is written. The workbench asks for an explicit replace-all confirmation. The CLI reports the conflicts and requires a rerun with `--force`. Share and import never run workflows.

## Format

Every workflow declares `version: v1alpha1`. The package stays semver `0.x`. A later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a herdr version. The plugin manifest and CLI own that.

Optional `title` and `description` appear in the picker. Title defaults from the humanized filename. The picker truncates both to the current row width (title on one line; description wraps to at most two). `hidden: true` hides a workflow from the picker. `hwf run` still works.

## Four actions

Exactly one action key per step:

| Action      | Role                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `run:`      | local argv or shell command → `{stdout, stderr, exit_code, failed}`    |
| `agent:`    | managed native agent turn → `{response, agent, pane_id}` when blocking |
| `herdr:`    | explicit socket method + `params:` → that method's structured result   |
| `workflow:` | isolated child workflow with its own inputs and optional `returns:`    |

Templates use `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}` only. Results are automatic. There is no `out:` binding.

Config is only `profiles` / `default_profile` / `transcripts`. See [Profiles](#profiles) for the shape and [Reference](/reference#config) for transcript extractors.

## Agent skill

To author workflows with an agent, install `skills/herdr-workflow-create`. See the [README](https://github.com/aorumbayev/herdr-workflows#agent-skill) for the paste-in prompt:

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Next

- [Examples](/examples) — import ready-made workflows
- [Reference](/reference) — panes, readiness, inputs, control flow, caps, trust, denylist
