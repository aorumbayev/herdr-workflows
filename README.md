<h3 align="center">
  herdr-workflows
</h3>

<p align="center">Automate stuff in herdr</p>

<p align="center">
  <a href="docs/guide.md">Guide</a> · <a href="docs/examples.md">Examples</a> · <a href="docs/reference.md">Reference</a>
</p>

<p align="center">
  <img src="docs/assets/workbench.png" alt="herdr-workflows web workbench — visual step editor" width="900" />
</p>

---

herdr-workflows is a [herdr](https://herdr.dev) plugin that runs short YAML workflows — sequences of `shell`, `open`, `agent`, and `herdr` steps — from a picker (`prefix+k`), the `hwf` CLI, or a local web workbench. herdr owns panes and UI; this plugin just sequences them.

## Install

You need [herdr](https://herdr.dev) **0.7.5** or newer.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

That compiles the plugin, puts `herdr-workflows` / `hwf` on your PATH, and binds `prefix+k` to the workflow picker.

Then, inside any repo:

```bash
cd your-repo
hwf init            # writes .hwf/config.yaml + a starter `review` workflow
```

Press `prefix+k` to pick and run a workflow, or use the CLI directly:

```bash
hwf run review      # run a workflow, live progress in the terminal
hwf                 # manage TUI: edit workflows/config, browse run log
hwf web             # open the browser workbench (build/edit/share; no run)
```

## Surfaces

| How                       | What                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `prefix+k` / `hwf launch` | picker popup — filter, pick, optional prompt line                       |
| `hwf run <name>`          | CLI — live step/stderr output; best for debugging                       |
| `hwf` (no args, TTY)      | manage TUI — edit workflows/config, browse the run log                  |
| `hwf web`                 | localhost workbench — browse/edit/validate/share, text or visual editor |

Running always happens through the picker or `hwf run` — it needs real herdr panes, so the web workbench builds and shares but never runs.

## Docs

Full documentation lives in [`docs/`](docs/guide.md).

## License

MIT
