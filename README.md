<h3 align="center">
  herdr-workflows
</h3>

<p align="center">Automate repetitive work in herdr</p>

<p align="center">
  <a href="https://aorumbayev.github.io/herdr-workflows/guide">Guide</a> · <a href="https://aorumbayev.github.io/herdr-workflows/examples">Examples</a> · <a href="https://aorumbayev.github.io/herdr-workflows/reference">Reference</a>
</p>

<p align="center">
  <img src="docs/assets/workbench.svg" alt="herdr-workflows in five chapters — the commands you retype, the YAML that replaces them, the picker, the run, the handoff" width="900" />
</p>

---

herdr-workflows is a [herdr](https://herdr.dev) plugin. It runs short linear YAML workflows with `run:`, `agent:`, `herdr:`, and `workflow:` steps.

Start a run from the picker (`prefix+k`) or the `hwf` CLI. herdr owns panes and UI. This plugin only loads and sequences steps. The format is `version: v1alpha1`.

```yaml
# .hwf/workflows/review.yaml
version: v1alpha1
steps:
  - id: diff
    run: [git, diff, HEAD]
  - agent: |
      Review this diff. Blocking issues only.

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    pane:
      open: beside
```

Treat workflow YAML as reviewed executable code. There is no sandbox. A trusted `run:` can call the full herdr CLI or socket as your user. The method denylist only blocks accidental misuse of server, plugin, and identity APIs.

## Install

You need [herdr](https://herdr.dev) **0.7.5** or newer and [Bun](https://bun.sh) **≥ 1.3**.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

Remote install compiles the checkout locally: a Bun-version preflight, `bun install --production --frozen-lockfile`, `bun build --compile`, then native setup. PATH commands install under `~/.local/bin` / `$XDG_BIN_HOME`. npm is not a distribution channel. Platforms are Linux and macOS; on Windows use WSL2 with Herdr and this plugin both installed inside WSL — a native Windows Herdr cannot pair with hwf running in WSL.

**One-time migration:** if your install predates `hwf update`, run `herdr plugin install aorumbayev/herdr-workflows` once more to obtain it. Later updates: `hwf update`. Linked checkouts use `bun run install:dev` instead.

Then set up profiles:

```bash
cd your-repo
hwf init            # team / repo-local: writes .hwf/config.yaml
hwf init --global   # personal: writes herdr plugin config dir (for ~/.hwf/workflows)
```

Both commands probe PATH for known kinds (`claude`, `codex`, `aider`, `cursor`, `opencode`). Each found kind becomes one profile. The alphabetically first detected kind is `default_profile`.

Use repo init for shared team config. Use `--global` when you run workflows from `~/.hwf/workflows` without a per-repo `.hwf`.

A profile is the name a workflow `using:` refers to. Add role-oriented profiles with startup `args` when one kind backs several roles:

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

Config merges in this order: global herdr plugin config, committed `.hwf/config.yaml`, then gitignored `.hwf/config.local.yaml`. Each layer replaces whole entries by name. You can repoint a shared profile on one machine.

Ready-made workflows live in [`examples/`](examples) and on the [Examples page](https://aorumbayev.github.io/herdr-workflows/examples). Each card copies a `hwf workflow import "<bundle>"` command.

Import reviews every bundled YAML and flags sensitive parts. The CLI confirms the reviewed preview first, then asks for one repo or global destination before it writes. The workbench asks for destination scope, then confirms. On name conflicts, the workbench asks for replace-all. The CLI needs `--force` on a rerun. Old single-workflow payloads are unsupported.

Press `prefix+k` to pick and run a workflow. In list mode, `Ctrl+K` opens actions (new, import, examples, open, share-copy, delete). Or use the CLI:

```bash
hwf run review      # run the workflow above, live progress in the terminal
hwf web             # browser workbench: build/edit/validate/share/import — never runs
hwf                 # same as `hwf web`
hwf update          # latest published release via herdr plugin install
hwf help run        # generated help for one command
hwf --version       # installed plugin version
```

Root help labels `v1alpha1` as the workflow format. It is independent of the plugin version.

Runs always go through the picker or `hwf run`. They need real herdr panes. The web workbench builds, shares, and imports. It never runs. Picker shortcuts reuse one live workbench per repository when that workbench is still reachable. An owned workbench also retires when the code it was built from changes.

## Agent skill

`skills/herdr-workflow-create` walks you through a v1alpha1 workflow. It keeps the web workbench canvas in sync and validates with this plugin loader before save:

```
Install the herdr-workflows toolkit so you can build workflows for me:

1. If `hwf` is not on PATH: herdr plugin install aorumbayev/herdr-workflows
2. Install the skill for this agent:
   npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
3. Read the installed herdr-workflow-create/SKILL.md so you know the authoring workflow.
4. In this repo: run `hwf init` if .hwf/config.yaml is missing, then start the workbench in
   the background with `hwf web --no-open` and give me the URL it prints.
5. Build a small test workflow — one `run: [git, status, --short]` step — save it, send me
   <url>#w=repo:<name>, and confirm the canvas draws it. Then interview me for the real one.
```

Or install it by hand:

```bash
npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
```

## Docs

- [Guide](https://aorumbayev.github.io/herdr-workflows/guide)
- [Examples](https://aorumbayev.github.io/herdr-workflows/examples)
- [Reference](https://aorumbayev.github.io/herdr-workflows/reference)
- [Contributing](CONTRIBUTING.md)

## License

MIT
