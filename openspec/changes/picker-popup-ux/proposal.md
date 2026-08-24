## Why

The picker popup is too small for in-popup `$EDITOR` and for browsing. Issue 47 locks a large percent-sized popup, console as a third tab with pop-out, and no zoom control. Issue 59 adds the picker visual pass so kind colors, tabs, hover, and status colors share one theme.

## What Changes

- Open the picker popup at percent geometry in `herdr-plugin.toml` (about 85% by 80%). Drop cell `64` by `15`.
- Keep editing inside the popup through `tea.ExecProcess` (`$EDITOR` then `$VISUAL`, then a hard error). No zoom, no editor pane handoff.
- Add a third picker tab for console browse. Tab cycles workflows, runs, and console. A pop-out key opens the existing placement flow and quits the picker.
- Enable Bubble Tea mouse reporting on the picker host so herdr can forward pointer events. Every pointer gesture keeps a keyboard path.
- Extend `tui.Theme` with the kind palette, hover (not reverse), muted location and chrome, warn on `invalid` and `!`, and runs status colors.
- Draw a visible three-tab bar with active and inactive states.
- Re-judge picker parity rows and `tui.CharmVerdicts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `picker-presentation`: three root tabs, visible tab bar, percent popup size, theme and hover, pointer reporting with keyboard twins
- `console-presentation`: console browse lives in the picker tab. Pop-out uses the existing pane placement flow
- `picker-editor-actions`: restates in-popup `tea.ExecProcess` editing against the large popup (no new editor surface)

## Impact

- **Code:** `herdr-plugin.toml` plus embed copy, `internal/tui`, `internal/picker`, `internal/runsbrowser`, `internal/console` (embed + pop-out only)
- **Tests:** picker tab cycle, pop-out, theme slots, hover versus reverse, status colors, mouse mode, updated chrome and parity tests
- **Docs:** `docs/surfaces.md`, `docs/charm-components.md`
- **Gates:** `go tool verify`, `openspec validate --all --strict`
- **Out of scope:** workflow YAML or JSON schema, console diagram redesign (issue 48), SQLite history (proposal C)
