# Guide

This guide covers install steps and workflow authoring. The [Reference](/reference) page holds the contract tables.

## Install

You need [herdr](https://herdr.dev) **0.7.5** or newer and [Bun](https://bun.sh) **≥ 1.3**.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

Remote install compiles the checkout through Herdr's managed build: a Bun-version preflight (fails naming the minimum when Bun is missing or older), `bun install --production --frozen-lockfile`, `bun build --compile`, then native setup. It does **not** download release binaries. Supported platforms are Linux and macOS.

Setup links `hwf` and `herdr-workflows` into `~/.local/bin` (or `$XDG_BIN_HOME`). Both PATH steps and the `prefix+k` binding are optional; skips print a note and continue. Add the bin directory to PATH if setup warns it is missing. Check with `hwf --version` / `herdr-workflows --version` and `herdr config check`.

npm is **not** a distribution channel. Releases are GitHub Releases only (`0.x` while the product major stays zero) — tags and notes, no binary assets.

### Windows via WSL2

Use WSL2 and install Herdr plus this plugin **inside** the Linux environment. Native Windows Herdr cannot pair with hwf in WSL (separate servers, separate sockets).

### Update

After you have a managed GitHub install that includes the `update` command:

```bash
hwf update
```

`hwf update` checks the latest **published** release (drafts are ignored), refuses linked development checkouts (`bun run install:dev` instead), and for managed installs runs `herdr plugin install aorumbayev/herdr-workflows --yes` from outside `HERDR_PLUGIN_ROOT`. Existing installs that predate `hwf update` need **one** manual `herdr plugin install aorumbayev/herdr-workflows` to obtain the command; later updates use `hwf update`. The picker may show a nonblocking `[run hwf update]` hint in the list-mode filter row when a newer published version exists.

Local development still uses `bun run install:dev` (compile + `herdr plugin link` + setup).

## Set up profiles

```bash
cd your-repo
hwf init            # team / repo-local: .hwf/config.yaml
# or
hwf init --global   # personal: herdr plugin config dir (for ~/.hwf/workflows)
```

Both commands scan PATH for known agent kinds (`claude`, `codex`, `aider`, `cursor`, `opencode`). Each found kind becomes one profile. The alphabetically first detected kind becomes `default_profile`.

Repo init also creates `.hwf/workflows/` and writes `.hwf/.gitignore` with `config.local.yaml` and `tmp/`. Use repo init when your team shares profiles in git. Use `--global` when you keep workflows in `~/.hwf/workflows` and want profiles without a checkout change.

### Profiles

A profile is the name a workflow `using:` field refers to. It is not an agent binary. `kind` names the native herdr agent kind. The live `agent.start` call decides whether that kind is supported.

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

`hwf init` writes one profile per kind. You add role names and `args` yourself. An `agent:` step with no `using:` and no `target:` uses `default_profile`.

Config merges across three layers. Each layer replaces whole entries by name.

1. Global plugin config (`$HERDR_PLUGIN_CONFIG_DIR/config.yaml`, from `herdr plugin config-dir`)
2. Committed `.hwf/config.yaml`
3. Gitignored `.hwf/config.local.yaml` for per-machine choices

You can point `deep-review` at a different kind locally. This does not change what the team shares.

If you have no workflows yet, import ready-made ones from [Examples](/examples). Each card copies the command `hwf workflow import "<bundle>"`. Import reviews every bundled YAML file. It flags sensitive content. The CLI confirms the reviewed preview first, then asks for one repo or global destination. The workbench asks for destination scope, then confirms. Each surface handles name conflicts on its own. See [Share and import](#share-and-import).

Treat workflow YAML as reviewed executable code. Opening a repository never runs a workflow. There is no sandbox. A trusted `run:` step can call the full herdr CLI or socket as your user.

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

1. Press `prefix+k`. Type `scratch`. Press enter.
2. Or run `hwf run scratch` from a terminal.
3. Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global). A repo name takes priority over a global name of the same name.

Minimal document:

```yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

## Pick a surface

| Where                     | Use it for                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `prefix+k` (picker)       | Run. List mode: `Ctrl+K` opens actions (new/import/examples/open/share/delete) |
| `hwf run <name>`          | Run from a script or terminal, with `--input k=v`                              |
| `hwf workflow inspect`    | Print input metadata. Optional `--resolve` for active dynamics                 |
| `hwf web` (or bare `hwf`) | Edit, share, review imports, browse the run log. Never executes                |
| `hwf help [command]`      | Show generated command and option help                                         |
| `hwf --version`           | Show the installed plugin version                                              |
| `hwf update`              | Install the latest published GitHub Release via Herdr                          |

Runs always go through the picker or `hwf run`. The workbench builds, shares, and imports workflows. It never executes them. Picker shortcuts and `hwf web` reuse one live authenticated workbench per repository, as long as the recorded endpoint still answers. An owned workbench also retires when the code it was built from changes.

Root help labels `v1alpha1` as the workflow format. It is independent of the plugin version.

### Picker actions palette

In list mode, `Ctrl+K` opens the actions palette. A single letter fires the action (no Enter). Escape returns to the list.

- `n` — new workflow (`#new`)
- `i` — import review (`#import`)
- `e` — open the examples docs in the browser
- `o` — open/edit the selected workflow (`#w=<source>:<name>`)
- `s` — copy the selected workflow's `hwf workflow import "…"` command and show a herdr notification (picker stays open)
- `d` — delete the selected workflow after `y`/`n` confirmation (picker stays open)

Open, share, and delete need a valid selection. New, import, and examples do not. The picker closes after a successful workbench handoff for new, import, and open.

### Share and import

Share produces the canonical command:

```bash
hwf workflow import "<bundle>"
```

The bundle is a gzip-compressed, base64-encoded `{name, yaml}[]` array. It is never empty. It holds the exact selected source plus every `workflow:` child it references, transitively. Resolution checks the repo first, then the global scope, the same order runtime uses. Local provenance is display-only. The bundle does not encode it. A cycle or a missing child fails the export. The old single-workflow `{v, name, body}` payload no longer works. Re-export the workflow instead.

The CLI import accepts that command or the raw encoded bundle only. The workbench `#import` view also accepts a single raw workflow YAML document (with an explicit name). Both surfaces reject unrelated shell text, show every YAML body and aggregate sensitivity warnings, and require one `repo` or `global` destination after review. The workbench list exposes Import next to New; a saved workflow's editor exposes Share into the share UI.

If a bundled name already exists in that scope, import writes nothing. The workbench asks for an explicit replace-all confirmation. The CLI reports the conflicts and requires a rerun with `--force`. Share and import never run workflows.

## Format

Every workflow declares `version: v1alpha1`. The package version stays semver `0.x`. A later, incompatible alpha version increments `v1alphaN`. Workflow YAML never declares a herdr version. The plugin manifest and the CLI own that version.

Optional `title` and `description` fields appear in the picker. Title defaults to the humanized filename. The picker truncates both fields to the current row width: title on one line, description wrapped to at most two lines. `hidden: true` hides a workflow from the picker. `hwf run` still works on a hidden workflow.

## Four actions

Each step uses exactly one action key:

| Action      | Role                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `run:`      | local argv or shell command → `{stdout, stderr, exit_code, failed}`    |
| `agent:`    | managed native agent turn → `{response, agent, pane_id}` when blocking |
| `herdr:`    | explicit socket method + `params:` → that method's structured result   |
| `workflow:` | isolated child workflow with its own inputs and optional `returns:`    |

Templates use only `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}`. Results attach automatically. There is no `out:` binding.

Config holds only `profiles`, `default_profile`, and `transcripts`. See [Profiles](#profiles) for the shape. See [Reference](/reference#config) for transcript extractors.

## Agent skill

To author workflows with an agent, install `skills/herdr-workflow-create`. See the [README](https://github.com/aorumbayev/herdr-workflows#agent-skill) for the paste-in prompt:

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Next

- [Examples](/examples) — import ready-made workflows
- [Reference](/reference) — panes, readiness, inputs, control flow, caps, trust, denylist
