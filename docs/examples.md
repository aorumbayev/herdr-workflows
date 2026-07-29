# Examples

Each card copies a `hwf workflow import "<bundle>"` command (gzip+base64 `{name, yaml}[]`).

Paste the copied command into the terminal (`hwf workflow import`) or the workbench Import view. The workbench also accepts pasted raw workflow YAML with an explicit name. Import reviews every YAML body, marks commands, transcript access, and sensitive herdr methods, then asks for confirmation and one repo or global destination before it writes.

On a name conflict, the workbench shows a replace-all prompt. The CLI needs `--force` on a rerun. See [Guide · Share and import](/guide#share-and-import). Old single-workflow payloads are rejected. Share and import never run workflows.

All shipped examples use `version: v1alpha1`. The source of truth is [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

<ExampleCards />

## Authoring tips

- Prefer the argv form `run: [cmd, arg]` for values that must be arguments.
- Start with `branch-check` for guarded inputs, custom choices, ordered `when:` guards, and `success_codes`.
- Use `{{steps.id.response}}` or `{{steps.id.stdout}}`. Results attach automatically.
- Background work needs a herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow's `on_failure:` only.
