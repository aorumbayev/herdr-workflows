## 1. Serve the generated sources

- [x] 1.1 Add `GET /api/schema` in `src/web/server.ts` returning `z.toJSONSchema(rawWorkflowSchema)`, behind the existing bearer auth, alongside the other read-only API routes
- [x] 1.2 Add `GET /api/methods` in `src/web/server.ts` returning the generated method table (method, allowed, reason, params) from `src/herdr-methods.generated.ts`
- [x] 1.3 Return `issues: [{path, message}]` from `handleFormat` beside the existing joined `error` string, leaving the string intact for existing callers
- [x] 1.4 Cover both endpoints and the issue paths in `test/web-server.test.ts`, including an issue whose path addresses a nested step key

## 2. Schema-derived field model in the page

- [x] 2.1 Fetch the schema and the method table during editor init and cache them on `state`, next to `state.profiles`
- [x] 2.2 Add `widgetFor(node)` resolving a schema node to a widget kind with its bounds, enumeration, and pattern: enum to selection, boolean to checkbox, bounded integer to numeric, string mapping to key/value rows, string-or-array to segmented, nested object to sub-group, unresolved to JSON entry
- [x] 2.3 Resolve `anyOf` branches that only add a template pattern to the enumerated branch plus free-text entry, so a whole-value template stays typeable on `pane.open`
- [x] 2.4 Add the presentation overlay table of `{label, help, group, order}` per step key, carrying no type information
- [x] 2.5 Replace `formFrom` and `stepFrom` with schema walks over the step keys, and reduce the per-verb key lists to the four payload keys
- [x] 2.6 Delete `fieldsFor` and `readPane`, moving the `pane.size` range to the schema-derived numeric widget
- [x] 2.7 Narrow `extraOf` and the carried-over-from-YAML notice to keys the served schema does not describe
- [x] 2.8 Emit placement fields as entered when the group's required key is unset, so no entered value is discarded

## 3. Intent sections

- [x] 3.1 Render fields into the four intent sections plus a trailing section for keys the overlay does not assign, in overlay order
- [x] 3.2 Collapse a section whose fields are all unset to a one-line summary, and summarise set values (for example `30s, retry 3×`)
- [x] 3.3 Give the section headers keyboard-operable disclosure with `aria-expanded`, using existing Nord tokens and focus affordances in both themes
- [x] 3.4 Keep canvas history covering form changes across sections, per `openspec/specs/web-workbench-editing/spec.md`

## 4. Payload widgets

- [x] 4.1 Render `retry` from the schema as `attempts` (schema minimum) and `delay`, removing the JSON textarea
- [x] 4.2 Render `env` and `inputs` as key/value rows with add and remove
- [x] 4.3 Replace the argv checkbox with a `shell | argv` segmented control, argv as one token per line, mapping lines to array elements
- [x] 4.4 Render the `herdr:` method as a selection from the generated table, presenting `allowed: false` entries as unavailable with their recorded reason
- [x] 4.5 Render the selected method's parameters from its specification: required marked, `enumValues` as selections, widget per `kinds`, JSON entry only when `additionalProperties` is true
- [x] 4.6 Preserve existing parameter values when the author switches method, keeping keys the new method's specification also names

## 5. Field-level validation reporting

- [x] 5.1 Map an issue path of `["steps", index, ...keys]` to the node and its field key, and paint the loader's message on that field
- [x] 5.2 Mark the containing section and badge the canvas node while a field carries an issue, clearing both when the issue is gone
- [x] 5.3 Keep an unaddressable issue in the editor status area as today
- [x] 5.4 Confirm no cross-field rule text or condition is duplicated in `page.html`

## 6. Tests and gates

- [x] 6.1 Extract the field model in `test/web-presentation.test.ts` and assert `widgetFor` resolves every step key in the served schema without falling back to JSON entry, except where the schema accepts unconstrained values
- [x] 6.2 Assert a step to form to step round-trip preserves every step key, covering `retry`, `env`, `pane`, argv `run`, and `success_codes`
- [x] 6.3 Assert issue-path to field-key mapping, including a nested path and an unaddressable path
- [x] 6.4 Assert an unknown-to-overlay schema key renders in the trailing section, and a key absent from the served schema stays carried over
- [x] 6.5 Run `bun test ./test` and `npm run verify`
