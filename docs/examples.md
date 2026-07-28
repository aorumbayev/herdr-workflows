# Examples

Each card copies a `hwf workflow import "<base64>"` command. Import prints the full YAML, marks commands, transcript access, and sensitive Herdr methods, asks for confirmation, then writes into repo or global `.hwf/workflows`.

All shipped examples use `version: v1alpha1`. Source of truth is [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

<ExampleCards />

## Authoring tips

- Prefer argv-form `run: [cmd, arg]` for values that must be arguments.
- Use `{{steps.id.response}}` / `{{steps.id.stdout}}` — results are automatic.
- Background work needs a Herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow's `on_failure:` only.
