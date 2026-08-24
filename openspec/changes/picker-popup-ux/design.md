## Context

Issue 47 dropped live popup zoom (herdr 0.8.2 has no resize API). Issue 59 folded the picker visual pass into the same change. The picker already hosts a runs browser, in-popup `tea.ExecProcess` editing, and a palette path that opens the console through placement. This change sizes the popup, adds a console tab plus pop-out, and paints shared theme slots.

## Goals / Non-Goals

**Goals:**

- Size the picker popup with percent width and height in the plugin manifest.
- Keep `$EDITOR` / `$VISUAL` inside the popup via `tea.ExecProcess`.
- Cycle three root tabs (workflows, runs, console) with Tab. Show a visible tab bar.
- Pop the console out to a real pane with the existing placement chooser, then quit the picker.
- Enable picker mouse reporting. Hover is not reverse-video. No pointer-only gesture.
- Put kind colors, muted chrome, warn markers, and run status colors on `tui.Theme`.
- Re-judge `internal/picker/parity.go` and `tui.CharmVerdicts`.

**Non-Goals:**

- No `popup.resize`, no close-and-reopen zoom.
- No `vi` editor fallback.
- No console diagram visual redesign (issue 48) and no refine loop (issue 49).
- No schema or workflow YAML edits.
- No mouse reporting on the standalone console host (proposal B).

## Decisions

1. **Percent geometry is `85%` by `80%`.** Issue 47 asked for about those values. Herdr accepts percent strings on popup panes. Cell `64` by `15` goes away.
2. **Tab cycles workflows then runs then console.** Tab still does not switch during input, live launch, run detail, palette, or confirmation. On the console tab, picker Tab wins over the console's own workflows/runs Tab so the popup does not nest two tab systems.
3. **Pop-out is `p` on the console tab.** The console tab has no filter field, so a bare letter is safe. Palette `c` still opens the placement chooser from workflows or runs. Both paths call `beginConsolePlacement` and quit after a successful pane open. Keyboard always works. Pointer select on the tab bar is an extra path, not the only one.
4. **Embedded console is browse-only.** Picker embeds `console.Model` with an embedded flag: skip the inner "workflows" title, ignore inner Tab, keep Enter for the existing diagram. Send-back stays available on the diagram because stripping it would be a silent product cut. Working sessions still belong on the popped-out pane (issue 49).
5. **Mouse mode is `MouseModeAllMotion`.** Issue 58 names `WithMouseCellMotion`. Bubble Tea v2 moved that to `view.MouseMode`. Hover needs motion reports (`?1003`), so the picker View sets `MouseModeAllMotion`. Wheel and pointer-select duplicate Up/Down and Tab. Hover never activates a row by itself.
6. **Theme slots stay indexed ANSI.** Kind: agent 6, run 2, herdr 5, workflow 4, default 7. Warn 3, reverse selection, underline hover, faint for secondary text. Run status: succeeded 2, failed 1, interrupted 3, running 6, stale faint. Lip Gloss has no ready theme for that set, so Charm stays keep-custom.
7. **Rows paint per cell, never once around the whole line.** An inner SGR reset ends an enclosing attribute, so wrapping a colored row in reverse or underline would drop the highlight partway across. `tui.RowBase` folds the cursor or hover attribute into every cell style. The runs browser paints its status token the same way.
8. **Location `invalid` and sensitivity `!` use warn. Location text otherwise is faint.** Footer hints and the rule are faint. Titles and the description keep the terminal foreground, because a pinned slot can land unreadable on the reader's own theme. Run status text uses the status slot. Reverse still marks the cursor row and wins over hover.

## Risks / Trade-offs

- [Percent popup clips on a tiny terminal] → Herdr already clamps popups to a minimum. The TUI still truncates to the renderer width.
- [ANSI in rows breaks exact-string tests] → tests that check layout strip ANSI and keep column counts through `tui.Columns`.
- [Console Tab conflict] → picker intercepts Tab on the console tab. Standalone `hwf console` is unchanged.
- [All-motion vs cell-motion] → all-motion is the minimum that makes hover real. Pointer select and wheel still work.

## Migration Plan

Alpha: replace cell popup size in the same change. No dual manifest. Rollback is revert of the branch.

## Open Questions

None. Issues 47, 58, and 59 lock the product calls. `85%` by `80%`, pop-out letter `p`, and `MouseModeAllMotion` are the implementation fills those issues left open.
