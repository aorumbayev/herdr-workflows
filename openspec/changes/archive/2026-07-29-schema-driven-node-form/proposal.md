## Why

The node parameters form hand-mirrors the step schema in five places (`fieldsFor`, `formFrom`,
`stepFrom`, `extraOf`, and the `pane.size` bounds inside `readPane`), so every alpha schema move
needs five matching edits in `src/web/page.html`. It has already drifted: `shell` is an enum in the
schema and a free-text input in the form, and `success_codes` has no widget at all, so it survives
only as an untouched key under the "kept from YAML" notice. The form also presents every step key as
one flat list of twenty labels, encodes `retry` as a raw JSON textarea for what the schema defines as
two scalars, and carries documentation inside labels (`cwd (new-agent only)`,
`retry — JSON {attempts, delay?}`). Loader rules reject combinations the form happily offers, and the
resulting message lands in a single status bar instead of on the field it names.

## What Changes

- Serve the workflow JSON Schema and the generated herdr method specs to the page, and derive the
  node form's fields, widgets, and bounds from them instead of from a hand-written field table.
- Keep a hand-authored overlay for labels, help text, and grouping only. A schema key missing from
  the overlay still renders, so a schema addition is visible rather than silently absent.
- Group fields into intent sections — what the step does, where it runs, when it runs, what happens
  if it fails — and collapse a section with nothing set to a one-line summary.
- Replace JSON textareas with typed widgets: `retry` as `attempts` and `delay`, `env` and `inputs` as
  key/value rows, string `run:` versus argv as a segmented control with one argv token per line, and
  `herdr:` `params:` as a per-method form driven by the method's own parameter spec.
- Present `herdr:` methods as a picker built from the generated method table, showing denied methods
  as unavailable together with the invariant they protect.
- Return loader validation issues with their paths so the workbench paints each message on the field
  it names, keeping every cross-field rule in the loader and none in the page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-workbench-editing`: Add node parameters form requirements covering schema-derived fields,
  intent sections, typed payload widgets, and field-level validation reporting.

## Impact

The change affects `src/web/page.html` (node parameters form), `src/web/server.ts` (two read-only
endpoints for the workflow schema and the herdr method table, plus validation issue paths on the
existing format response), and their tests. No parser, loader, runner, CLI, or payload behavior
changes: the schema and the method table are already generated, and cross-field rules stay in the
loader. Workflow YAML is unaffected, and the YAML editing mode remains the escape hatch for anything
the form does not model.
