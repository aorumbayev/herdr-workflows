## Why

The web workbench makes save state and editing history difficult to understand, while low canvas contrast makes workflows harder to scan. Canvas-to-YAML formatting also emits invalid YAML for recovery actions with nested fields, blocking a normal mode switch for valid workflows such as `handoff`.

## What Changes

- Remove the redundant move-to-scope action and make scope changes explicit unsaved edits applied by Save.
- Show an unsaved marker and Save only when the workflow differs from its saved baseline.
- Add Undo and Redo controls that follow the active YAML or canvas editor mode.
- Add an in-page expanded canvas view that fills the browser viewport and exits with Escape.
- Increase structural contrast among the canvas, nodes, ports, and edges in both Nord themes.
- Correct recovery-action serialization so canvas-to-YAML round trips remain valid.

## Capabilities

### New Capabilities

- `web-workbench-editing`: Workflow dirty state, explicit save and scope behavior, mode-aware history, expanded canvas behavior, and valid visual-editor round trips.

### Modified Capabilities

- `web-workbench-presentation`: Strengthen canvas structural contrast and require accessible history, save-state, and expanded-view affordances in both themes.

## Impact

The change affects `src/web/page.html`, the shared web workflow serializer in `src/web/server.ts`, and focused web server/presentation tests. It changes no workflow grammar, CLI contract, API route, dependency, or persisted data format.
