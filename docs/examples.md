# Examples

Each card copies a `hwf workflow import "<bundle>"` command (gzip+base64 `{name, yaml}[]`). Import reviews every bundled YAML, marks commands, transcript access, and sensitive Herdr methods, asks for confirmation and one repo or global destination, then writes. Name conflicts: workbench replace-all prompt, or CLI `--force` on rerun — see [Guide · Share and import](/guide#share-and-import). Old single-workflow payloads are rejected. Share and import never run workflows.

All shipped examples use `version: v1alpha1`. Source of truth is [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

<ExampleCards />

## Authoring tips

- Prefer argv-form `run: [cmd, arg]` for values that must be arguments.
- Use `{{steps.id.response}}` / `{{steps.id.stdout}}` — results are automatic.
- Background work needs a Herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow's `on_failure:` only.
