## 1. Specs and Charm record

- [x] 1.1 Delta specs for console-presentation and picker-presentation
- [x] 1.2 Re-judge `runs-detail-scroll` and add `console-hit-zones` plus `console-mouse-reporting` in `tui.CharmVerdicts` and `docs/charm-components.md`

## 2. Projection and theme

- [x] 2.1 Fill `ProjectDiagram` labels for argv-form run and agent prompt first line
- [x] 2.2 Add `Theme.KindStyle` that spends the existing kind slots

## 3. Card rail and YAML pane

- [x] 3.1 Header-strip card rail with kind border, meta rows, centered connectors, windowing
- [x] 3.2 Always-visible raw-YAML pane with hand-rolled highlighting from `tui.Theme`, scrollable past the viewport
- [x] 3.3 Title order: id, derived label, `step N`, muted index suffix on derived names

## 4. Send-back, watch, mouse

- [x] 4.1 Bundle = file path, focus ids, insert-versus-modify anchor, instruction, skill pointer. No YAML fragments. Empty selection = whole workflow
- [x] 4.2 Shared file poll, one armed tick per open diagram: last-good diagram plus loader error status. Re-resolve selection by declared id. Keep scroll
- [x] 4.3 `click` / `ctrl+click` / wheel / card anchors / `a` asks a side and `d` seed the existing composer. No drag. No YAML writer
- [x] 4.4 Enable mouse reporting on standalone console. Forward picker console-tab pointer events past the tab bar

## 5. Parity and verify

- [x] 5.1 Parity rows for rail, YAML pane, watch, `click`, wheel, `a`, `d`, re-resolution, mouse reporting
- [x] 5.2 `go tool verify` green
