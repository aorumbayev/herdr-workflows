## Why

Issues 48, 49, 57, and 58 lock the console diagram as a `master-detail` card rail, a send-back refine loop that edits the workflow file, mouse-navigable hit zones, and Bubble Tea mouse reporting in both hosts. The current console still draws a flat ASCII list and a fragment-based send-back bundle.

## What Changes

- Replace the flat diagram list with a header-strip card rail (kind on the top border, kind-colored, meta rows, centered connectors) plus an always-visible raw-YAML detail pane with hand-rolled highlighting.
- Enrich `workflow.ProjectDiagram` labels: declared id, else derived run argv / agent prompt first line / herdr method / child name, else `step N`.
- Spend `tui.Theme` kind colors. Do not add a second palette.
- Upgrade send-back in place: bundle is workflow file path, focus step ids, insert-versus-modify anchor, user instruction, and `hwf skills show herdr-workflow-create`. No YAML fragments. Empty selection means the whole workflow.
- Watch the workflow file as shared console infrastructure. Invalid saves keep the last-good diagram and show the loader error on the status line. Selection re-resolves by declared step id.
- Mouse is navigable, never editable. Select a card, `ctrl+click` multi-select, wheel scrolls. No drag. Gaps are insert anchors. `a` and `d` seed the existing composer. Keyboard twins exist for every pointer gesture.
- Enable Bubble Tea mouse reporting on the standalone console and keep it on the picker host. Forward pointer events from the picker console tab into the embedded console after the tab bar.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `console-presentation`: card-rail diagram, YAML detail, file watch, upgraded send-back, mouse navigation, mouse reporting in both hosts
- `picker-presentation`: picker console tab forwards pointer events into the embedded console

## Impact

- **Code:** `internal/workflow` label enrichment, `internal/tui` kind style helper and Charm re-judgement, `internal/console` rail/YAML/watch/mouse/send-back, `internal/picker` mouse forward
- **Tests:** diagram labels, rail layout, YAML color, watch last-good, send-back bundle, mouse hit zones, picker forward, parity rows
- **Docs:** `docs/charm-components.md`
- **Gates:** `go tool verify`, `openspec validate --all --strict`
- **Out of scope:** YAML grammar, a console YAML writer, drag-reorder, bubbles viewport, chroma
