# Examples

Each card copies a `hwf workflow import "<bundle>"` command (gzip+base64 `{name, yaml}[]`).

Import reviews every bundled YAML. It marks commands, transcript access, and sensitive herdr methods. It asks for confirmation and one repo or global destination, then writes.

On name conflicts, the workbench shows a replace-all prompt. The CLI needs `--force` on a rerun. See [Guide · Share and import](/guide#share-and-import). Old single-workflow payloads are rejected. Share and import never run workflows.

All shipped examples use `version: v1alpha1`. Source of truth is [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

<ExampleCards />

## Authoring tips

- Prefer argv-form `run: [cmd, arg]` for values that must be arguments.
- Use `{{steps.id.response}}` / `{{steps.id.stdout}}`. Results are automatic.
- Background work needs a herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow `on_failure:` only.
