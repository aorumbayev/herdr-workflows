## Context

`src/web/page.html` renders node parameters from `fieldsFor(verb)`, converts a step into form values
with `formFrom`, converts form values back with `stepFrom`, sets aside keys it has no widget for in
`extraOf`, and re-states the `pane.size` range inside `readPane`. Five hand-maintained mirrors of one
schema, in an alpha product whose schema still moves. Two drifts already shipped: `shell` is
`enum [sh, bash, zsh, pwsh, powershell, cmd]` in the schema and a free-text input in the form, and
`success_codes` has no widget at all.

Two generated sources of truth already exist and are already tested for freshness:

- `docs/workflow.schema.json`, produced by `scripts/generate-schema.ts` from `rawWorkflowSchema` via
  `z.toJSONSchema`, guarded by `test/schema.test.ts`. It carries types, enumerations, bounds,
  patterns, nesting, and `required` for every step key — including `retry` as
  `{attempts: integer minimum 2, delay: duration string}` and `pane` as an object requiring `open`.
- `src/herdr-methods.generated.ts`, produced by `scripts/generate-herdr-methods.ts` from
  `schemas/herdr-api.schema.json`, guarded by `test/herdr-methods-generated.test.ts`. Every method
  entry carries `required`, `properties` with `kinds` and `enumValues`, `additionalProperties`, and an
  `allowed: false` reason for denied methods.

Cross-field rules are deliberately not in either source. `AGENTS.md` states that cross-field rules
live in the loader, and `parse.ts` enforces them in `superRefine`: `background` rejects `timeout` and
`retry`, `ready_when` rejects `retry` and requires `pane` and `timeout`, `pane` requires `background`
or `ready_when`, `success_codes` applies only to a blocking local `run:`. The form currently offers
every key regardless, and the resulting loader message reaches the author only as a joined string in
the status bar, because `handleFormat` in `src/web/server.ts` maps issues to `i.message` and drops
`i.path`.

Governing specs: `openspec/specs/web-workbench-editing/spec.md` (canvas history covering "form
changes", canvas-to-YAML serialisation) and `openspec/specs/web-workbench-presentation/spec.md`
(Nord tokens, both themes, interactive affordances, accessible controls).

## Goals / Non-Goals

**Goals:**

- One presentation table to maintain instead of five schema mirrors, so a schema move costs a
  regeneration and nothing else.
- Schema drift that degrades to a generic widget in a trailing section, never to a missing field.
- No JSON authoring for values the schema describes structurally.
- Loader messages that land on the field they name, with zero rule logic copied into the page.

**Non-Goals:**

- Changing the workflow grammar, the loader, or any runtime behavior. The schema and the method table
  are consumed as they already are.
- Mirroring loader cross-field rules in the page as hiding or disabling. Deliberately rejected below.
- Template autocomplete inside form fields. `CONTEXT_HINTS` serves YAML mode; the form gets none for
  now.
- A build step. `page.html` stays a single file served as text by `src/web/server.ts`.

## Decisions

### Serve the schema from Zod, not the committed JSON file

`GET /api/schema` returns `z.toJSONSchema(rawWorkflowSchema)`, the same call
`scripts/generate-schema.ts` makes. Reading `docs/workflow.schema.json` from disk would add a path
dependency and could serve a stale file when someone forgets `bun run schema`; deriving it in the
process cannot go stale. `GET /api/methods` returns the generated method table. Both are read-only,
behind the existing bearer auth, fetched once during editor init alongside `state.profiles`.

Alternative considered: embedding the schema into `page.html` at serve time. Rejected — it grows an
already large page and gains nothing over one cached fetch.

### Widget from schema, words from an overlay

`widgetFor(node)` resolves a schema node to a widget: enumerated string to a selection, boolean to a
checkbox, integer with `minimum`/`maximum` to a numeric entry carrying those bounds, `object` with
string `additionalProperties` to key/value rows, `anyOf` of string and array-of-string to a segmented
control, nested `object` to a sub-group, anything unresolved to JSON entry. `anyOf` branches that only
add a template pattern (as on `pane.open`) resolve to the enumerated branch plus free-text entry, so a
whole-value template stays typeable.

The overlay is one table of `{label, help, group, order}` per key. It carries no type information, so
it cannot contradict the schema. A key absent from the overlay renders from its schema type into the
trailing section. This replaces `fieldsFor`, `formFrom`, `stepFrom`, and `readPane`, and shrinks the
per-verb key lists to the four payload keys (`run` with `shell`, `agent` with `using` and `target`,
`herdr` with `params`, `workflow` with `inputs`). Every other step key renders for every verb and the
loader judges the combination.

`extraOf` and the "kept from YAML" notice stay, now covering only keys the *served schema* does not
describe rather than keys the page has no widget for.

### Conditionals are server-driven

The page hides and disables nothing to anticipate a loader rule. `handleFormat` gains
`issues: [{path, message}]` beside its existing joined `error` string, and the client maps
`["steps", i, "retry", "attempts"]` to node `i` and field `retry.attempts`, paints the loader's own
message there, marks the section header, and badges the canvas node. Unaddressable issues keep today's
status-bar behavior.

Alternatives considered: mirroring `superRefine` rules in the page for a guided feel — rejected,
because every loader rule change would then need a matching page change and would be silently wrong
when it drifts. Gating a nested group on its schema `required` key — rejected as the same class of
duplication for a smaller win.

A consequence: `readPane` currently returns `null` and drops `pane.target`, `pane.workspace`,
`pane.size`, and `pane.focus` whenever `pane.open` is empty. Under server-driven reporting the group
is emitted as entered and the loader answers with `pane` requiring `open`, so a silent value drop
disappears without adding a rule to the page.

### Sections ordered by authoring intent

Four sections — what it does, where it runs, when it runs, if it fails — plus a trailing section for
unassigned keys. A section with nothing set collapses to a summary line (`30s, retry 3×`), which is
what keeps a form that renders more keys than before from reading as a longer wall. Alternative
considered: n8n's Parameters/Settings tabs. Rejected — it moves the undifferentiated pile one click
away instead of differentiating it.

Presentation stays within `openspec/specs/web-workbench-presentation/spec.md`: existing Nord tokens,
both themes, focus affordances on the new disclosure controls, and `aria-expanded` on section headers.

### Payload widgets

`retry` falls out of the schema as `attempts` (minimum 2) and `delay` (duration pattern) with no
special case. `run` gets a `shell | argv` segmented control replacing the "treat run as argv JSON
array" checkbox, with argv as one token per line — note that `AGENTS.md` forbids templates in string
`run:` and allows them per argv element, so the segmented control also makes the templatable form
discoverable. `herdr` gets a method selection from the generated table, denied entries shown
unavailable with their recorded reason, and a per-method parameter form from `properties`, `kinds`,
`enumValues`, and `required`; JSON entry remains only where `additionalProperties` is true.

### Testing

`test/web-presentation.test.ts` already extracts a JavaScript block from the served page and evaluates
it. The same approach covers `widgetFor` against every step key in the served schema, a
step to form to step round-trip that must preserve each key, issue-path to field-key mapping, and the
placement group no longer dropping sibling values. Endpoint shape and issue paths are covered in
`test/web-server.test.ts` alongside the existing `/api/format` tests.

## Risks / Trade-offs

- A future schema shape the resolver cannot classify renders as JSON entry → the fallback is explicit
  and the trailing-section rule keeps it visible and editable; the overlay can then name it.
- Rendering nearly every step key for every verb lets an author reach an invalid combination before
  the loader answers → collapsed sections keep unset keys out of sight, and validation already runs on
  every canvas change, so the answer arrives on the field within one sync.
- One extra round trip during editor init for two documents → both are cached for the editor's
  lifetime, and init already fetches profiles.
- `z.toJSONSchema` output shape is a Zod implementation detail the page now parses → it is already the
  committed public schema artifact, and `test/schema.test.ts` fails when it changes unexpectedly.
- The page grows a small schema interpreter while losing four hand-written mirrors → net code is
  roughly flat, and the remaining hand-maintained surface is one table of labels.
