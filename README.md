<h3 align="center">
  herdr-workflows
</h3>

<p align="center">Automate stuff in herdr</p>

<p align="center">
  <a href="docs/guide.md">Guide</a> · <a href="docs/examples.md">Examples</a> · <a href="docs/reference.md">Reference</a>
</p>

---

herdr-workflows is a [herdr](https://herdr.dev) plugin that runs short YAML workflows — sequences of `shell`, `open`, `agent`, and `herdr` steps — from a picker (`prefix+k`) or the `hwf` CLI. herdr owns panes and UI; this plugin just sequences them.

## Install

You need [herdr](https://herdr.dev) **0.7.4** or newer.

```bash
herdr plugin install @aorumbayev/herdr-workflows
```

That puts `herdr-workflows` / `hwf` on PATH and binds `prefix+k` to the workflow picker.

```bash
cd your-repo && hwf init
hwf run handoff --input target=codex   # or press prefix+k
```

## Docs

Documentation lives in [`docs/`](docs/guide.md).

## License

MIT
