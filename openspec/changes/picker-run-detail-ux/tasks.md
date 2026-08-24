## 1. Shared rail and step source

- [x] 1.1 Move `railCard`, `railSplit`, `renderRailYAML`, `railSegments`, `windowSegs`, `centerPlain`, `padPlain`, and `selectMark` from `internal/console/rail.go` into `internal/tui` as a `CardSpec{Kind, Title, Body, Focused, Selected, Muted}` adapter.
- [x] 1.2 Map `workflow.DiagramNode` to `tui.CardSpec` in `internal/console` so the diagram renders byte-identically.
- [x] 1.3 Move `splitStepYAML` and `colorYAML` to a shared home both surfaces import.
- [x] 1.4 Add `history.FailureFact.Verdict` and `history.FailureFact.Stream`, read from the existing capture details. Keep snapshot version 1 compatible.
- [x] 1.5 Update tests and parity rows for the moved rail. Keep `go tool verify` green.

## 2. Actions palette and edit placement

- [x] 2.1 Change palette labels to single words and hide `edit`, `share`, and `delete` without a valid selection. Keep keys `n i e c o s d`.
- [x] 2.2 Add the edit placement chooser (`popup`, `beside`, `below`, `tab`). In-popup keeps `tea.ExecProcess`, respawns at the console size for the editor, and respawns compact after validation.
- [x] 2.3 Add the `editor` plugin entrypoint and the managed external-editor pane that closes on exit. Wire `plugin.pane.open` for beside/below/tab.
- [x] 2.4 Update `internal/picker/parity.go` and tests for the palette and chooser.

## 3. Failed-run detail and send-back

- [x] 3.1 Render the runs detail as a card rail of steps using `tui.CardSpec`, with the focused failed step double-bordered.
- [x] 3.2 Render the right pane: header, cause per action kind, command and exit code, 500-byte output tail, step source with fallback.
- [x] 3.3 Add the `s` send-back that reuses `formatAnnotationBundle` plus the `--- failure ---` block and the agent-picker flow.
- [x] 3.4 Update `internal/runsbrowser/parity.go`, `tui.CharmVerdicts`, and tests. Keep `go tool verify` green.
- [x] 3.5 Respawn run detail at the console size and respawn the compact Runs list on Escape. Update picker-presentation, parity rows, and tests.
