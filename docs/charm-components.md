# Charm component evaluation

Decision 16 evaluates every hand-written picker and TUI mechanism against the latest stable Charm modules. Use a Charm component only when it meets required behavior with less product code and unchanged UX. Default is keep custom code. Each keep-custom row names the missing capability and a focused test.

## Exact versions (2026-08-22)

Versions come from `go list -m -u` for direct modules and from `proxy.golang.org` `@latest` for candidates not in `go.mod`.

| Module | Latest stable | In `go.mod` |
| --- | --- | --- |
| `charm.land/bubbletea/v2` | v2.0.9 | v2.0.9 |
| `charm.land/lipgloss/v2` | v2.0.6 | v2.0.6 |
| `charm.land/bubbles/v2` | v2.1.1 | not added |
| `charm.land/huh/v2` | v2.0.3 | not added |
| `github.com/charmbracelet/x/ansi` | v0.11.8 | v0.11.8 |

This cycle does not add `bubbles` or `huh`. Unused modules violate YAGNI.

## Verdict table

| Mechanism | Candidate | Version | Decision | Missing capability | Focused test |
| --- | --- | --- | --- | --- | --- |
| Fixed six-row list viewport | `bubbles/v2` list | v2.1.1 | keep-custom | `list.Model` pagination owns `PerPage` and optional paginator chrome. It cannot lock six rows with cursor-offset scrolling and no scroll thumb. | `TestCharmVerdicts` |
| Filter text accumulation | `bubbles/v2` textinput | v2.1.1 | keep-custom | No product key routing that keeps Ctrl+P, Tab, and Ctrl+G out of the filter while bare letters still type. | `TestCharmVerdicts` |
| FilterInput stdin leak drop | `bubbletea/v2` | v2.0.9 | keep-custom | `tea.WithFilter` has no herdr prefix-key C0 allowlist that keeps Tab, LF, CR, ESC, Ctrl+K, Ctrl+P, Ctrl+G, and Ctrl+V. | `TestCharmVerdicts` |
| Choice list plus custom row | `huh/v2` Select | v2.0.3 | keep-custom | No tagged `custom...` sentinel that opens free text under the same six-row ASCII chrome. | `TestCharmVerdicts` |
| Text prompt | `huh/v2` Input | v2.0.3 | keep-custom | Standalone form field. It does not share picker filter or backtrack state with ASCII submit chrome. | `TestCharmVerdicts` |
| Footer and position counter | `bubbles/v2` help or status | v2.1.1 | keep-custom | No hint-left index/total-right footer that clips the hint before the counter. | `TestFormatListFooter` |
| Two-line detail wrap | `lipgloss/v2` | v2.0.6 | keep-custom | No two-line wrap with `RowTextIndent` that truncates only line two with ASCII ellipsis. | `TestFormatDetailLines` |
| Inset muted horizontal rule | `lipgloss/v2` | v2.0.6 | keep-custom | No inset dash rule matched to `RowTextIndent` and content width. | `TestFormatRuleInsetMuted` |
| Field edge under a free-text field | `lipgloss/v2` | v2.0.6 | keep-custom | Borders derive the edge width from the rendered block, so a field edge cannot be narrower than its row. `FormatFieldEdge` repeats the `ASCIIBorder` bottom glyph at an explicit width. The picker update hint shares only the value row, so both edges stay full width. | `TestFieldEdgeIsOneASCIIRowNoColumns` |
| Horizontal content padding | `lipgloss/v2` | v2.0.6 | keep-custom | `Padding` does not pair with `StripContentPadding` or the `Truncate` ASCII ellipsis for the one-cell popup inset on every line. | `TestPadContentAddsHorizontalPadding` |
| Fixed two-row detail block | `lipgloss/v2` | v2.0.6 | keep-custom | `Style.Height` reserves blank rows but does not wrap detail text onto two indented lines with ASCII ellipsis on line two. | `TestFormatDetailBlockReservesTwoRows` |
| Column row layout | `bubbles/v2` ItemDelegate | v2.1.1 | keep-custom | No built-in cursor prefix, title truncate, warning, and location columns. | `TestPadColumnsKeepsASCIIIndicatorSingleColumn` |
| ASCII-only chrome strings | `bubbles/v2` styles | v2.1.1 | keep-custom | Default glyphs are not single-column ASCII `ChromeStrings`. | `TestChromeStringsAreSingleColumnASCII` |
| Terminal-column truncate | `x/ansi` | v0.11.8 | keep-custom | Width helpers exist. Product still owns ASCII `Ellipsis` and `PadColumns`. | `TestTruncateEllipsisAtMax` |
| Theme warning versus muted | `lipgloss/v2` | v2.0.6 | keep-custom | No ready theme for indexed ANSI warn (3), faint muted, color-only placeholder (8), and reverse without OSC 4. | `TestDefaultThemeUsesIndexedWarnMutedAndReverse` |
| Filter-row update indicator | `bubbles/v2` FilterInput | v2.1.1 | keep-custom | No width-gated ASCII update hint that hides under a four-cell filter floor. Picker owns the row. TUI tests cover `Truncate` and `PadColumns`. | `TestPadColumnsKeepsASCIIIndicatorSingleColumn` |
| Palette body | `bubbles/v2` | v2.1.1 | keep-custom | No Ctrl+P letter-fire palette that hides edit/share/delete without a selection. | `TestCharmVerdicts` |
| Delete confirm y/n | `huh/v2` Confirm | v2.0.3 | keep-custom | Confirm does not match bare y/n/esc and `DeleteConfirmHint` ASCII chrome. | `TestChromeStringsAreSingleColumnASCII` |
| Collected-answers truncation | `bubbles/v2` | v2.1.1 | keep-custom | No `chosen: name=value` join truncated with ASCII ellipsis. Uses `tui.Truncate`. | `TestTruncateEllipsisAtMax` |
| Viewport height pad | `bubbletea/v2` | v2.0.9 | keep-custom | Bubble Tea does not clear unused TTY rows after a shorter frame. `PadHeight` appends blank lines to the prior frame height. | `TestPadHeight` |
| Runs detail scroll | `bubbles/v2` viewport | v2.1.1 | keep-custom | `viewport.Model` has no scrollbar chrome and keeps `SoftWrap` off by default. Runs detail still scrolls a fixed ASCII window over pre-wrapped lines with clamped offset and no bubbles import. | `TestScrollDetailLines` |
| Theme kind palette | `lipgloss/v2` | v2.0.6 | keep-custom | No ready theme for indexed kind colors (agent 6, run 2, herdr 5, workflow 4, default 7), fail 1, faint secondary text, underline hover distinct from reverse, and run status slots. | `TestDefaultThemeKindPaletteAndHover` |
| Picker tab bar | `bubbles/v2` | v2.1.1 | keep-custom | Bubbles tabs do not center a three-label ASCII bar with reverse active and muted inactive states under picker chrome width rules, and give no column-to-tab hit test for the centered row. Picker owns `FormatTabBar`. | `TestFormatTabBarActiveReverseInactiveMuted` |
| Picker mouse hover | `bubbletea/v2` | v2.0.9 | keep-custom | Bubble Tea reports mouse cells but does not map hover to a non-reverse row style while reverse remains the keyboard cursor. | `TestPickerHoverStyleIsNotReverse` |
| Console hit zones | `bubbletea/v2` | v2.0.9 | keep-custom | Bubble Tea reports mouse cells but has no hit-zone registry for diagram cards. | `TestModelDiagramClickFocusesCard` |
| Console mouse reporting | `bubbletea/v2` | v2.0.9 | keep-custom | Mouse reporting stays off unless the view sets MouseMode. Both console hosts enable all-motion reporting. | `TestModelConsoleViewEnablesMouseReporting` |
| Card rail | `lipgloss/v2` | v2.0.6 | keep-custom | No kind-colored double-border card rail with ASCII connectors and a paired detail pane. | `TestFormatDiagramHandoff` |
| Edit placement | `huh/v2` Select | v2.0.3 | keep-custom | Select does not mix an in-popup `tea.ExecProcess` path with `plugin.pane.open` placements that quit without reopening. | `TestEditPlacementTabQuitsWithoutReopen` |
| Failed-run send-back | `bubbles/v2` | v2.1.1 | keep-custom | No send-back that reuses the annotation bundle plus a failure block that excludes the captured output tail. | `TestRunsSendbackOmitsOutputTail` |

Machine-readable copy lives in `tui.CharmVerdicts()`.
