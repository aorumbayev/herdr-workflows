# Charm component evaluation

Decision 16 evaluates every hand-written picker and TUI mechanism against the latest stable Charm modules. Use a Charm component only when it meets required behavior with less product code and unchanged UX. Default is keep custom code. Each keep-custom row names the missing capability and a focused test.

## Exact versions (2026-08-22)

Versions come from `go list -m -u` for direct modules and from `proxy.golang.org` `@latest` for candidates not in `go.mod`.

| Module | Latest stable | In `go.mod` |
| --- | --- | --- |
| `charm.land/bubbletea/v2` | v2.0.9 | v2.0.9 |
| `charm.land/lipgloss/v2` | v2.0.6 | v2.0.6 |
| `charm.land/bubbles/v2` | v2.2.0 | not added |
| `charm.land/huh/v2` | v2.0.3 | not added |
| `github.com/charmbracelet/x/ansi` | v0.11.8 | v0.11.8 |

This cycle does not add `bubbles` or `huh`. Unused modules violate YAGNI.

## Verdict table

| Mechanism | Candidate | Version | Decision | Missing capability | Focused test |
| --- | --- | --- | --- | --- | --- |
| Fixed six-row list viewport | `bubbles/v2` list | v2.2.0 | keep-custom | `list.Model` pagination owns `PerPage` and optional paginator chrome. It cannot lock six rows with cursor-offset scrolling and no scroll thumb. | `TestCharmVerdicts` |
| Filter text accumulation | `bubbles/v2` textinput | v2.2.0 | keep-custom | No product key routing that keeps Ctrl+K, Tab, and Ctrl+G out of the filter while bare letters still type. | `TestCharmVerdicts` |
| FilterInput stdin leak drop | `bubbletea/v2` | v2.0.9 | keep-custom | `tea.WithFilter` has no herdr prefix-key C0 allowlist that keeps Tab, LF, CR, ESC, Ctrl+K, and Ctrl+G. | `TestCharmVerdicts` |
| Choice list plus custom row | `huh/v2` Select | v2.0.3 | keep-custom | No tagged `custom...` sentinel that opens free text under the same six-row ASCII chrome. | `TestCharmVerdicts` |
| Text prompt | `huh/v2` Input | v2.0.3 | keep-custom | Standalone form field. It does not share picker filter or backtrack state with ASCII submit chrome. | `TestCharmVerdicts` |
| Footer and position counter | `bubbles/v2` help or status | v2.2.0 | keep-custom | No hint-left index/total-right footer that clips the hint before the counter. | `TestFormatListFooter` |
| Two-line detail wrap | `lipgloss/v2` | v2.0.6 | keep-custom | No two-line wrap with `RowTextIndent` that truncates only line two with ASCII ellipsis. | `TestFormatDetailLines` |
| Inset muted horizontal rule | `lipgloss/v2` | v2.0.6 | keep-custom | No inset dash rule matched to `RowTextIndent` and content width. | `TestFormatRuleInsetMuted` |
| Column row layout | `bubbles/v2` ItemDelegate | v2.2.0 | keep-custom | No built-in cursor prefix, title truncate, warning, and location columns. | `TestPadColumnsKeepsASCIIIndicatorSingleColumn` |
| ASCII-only chrome strings | `bubbles/v2` styles | v2.2.0 | keep-custom | Default glyphs are not single-column ASCII `ChromeStrings`. | `TestChromeStringsAreSingleColumnASCII` |
| Terminal-column truncate | `x/ansi` | v0.11.8 | keep-custom | Width helpers exist. Product still owns ASCII `Ellipsis` and `PadColumns`. | `TestTruncateEllipsisAtMax` |
| Theme warning versus muted | `lipgloss/v2` | v2.0.6 | keep-custom | No ready theme for indexed ANSI warn (3), muted (8), and reverse without OSC 4. | `TestDefaultThemeUsesIndexedWarnMutedAndReverse` |
| Filter-row update indicator | `bubbles/v2` FilterInput | v2.2.0 | keep-custom | No width-gated ASCII update hint that hides under a four-cell filter floor. Picker owns the row. TUI tests cover `Truncate` and `PadColumns`. | `TestPadColumnsKeepsASCIIIndicatorSingleColumn` |
| Palette body | `bubbles/v2` | v2.2.0 | keep-custom | No Ctrl+K letter-fire palette with saved filter and selection-dependent lines. Picker-owned, not `tui`. | `TestCharmVerdicts` |
| Delete confirm y/n | `huh/v2` Confirm | v2.0.3 | keep-custom | Confirm does not match bare y/n/esc and `DeleteConfirmHint` ASCII chrome. | `TestChromeStringsAreSingleColumnASCII` |
| Collected-answers truncation | `bubbles/v2` | v2.2.0 | keep-custom | No `chosen: name=value` join truncated with ASCII ellipsis. Uses `tui.Truncate`. | `TestTruncateEllipsisAtMax` |
| Viewport height pad | `bubbletea/v2` | v2.0.9 | keep-custom | Bubble Tea does not clear unused TTY rows after a shorter frame. `PadHeight` appends blank lines to the prior frame height. | `TestPadHeight` |
| Runs detail scroll | `bubbles/v2` viewport | v2.2.0 | keep-custom | `viewport.Model` brings scrollbars, mouse, and soft-wrap chrome. Runs detail needs a fixed ASCII window over pre-wrapped lines with clamped offset and no thumb. | `TestScrollDetailLines` |

Machine-readable copy lives in `tui.CharmVerdicts()`.

## Decision records (keep-custom)

### Fixed six-row list viewport

`bubbles/v2` `list.Model` sizes pages from available height and can show pagination chrome. The product requires a fixed six-row window, cursor-driven offset, and no scroll thumb. Keep the hand-written viewport in picker and runs browser.

### Filter text accumulation

Filter typing must ignore Ctrl+K, Tab, and other mods while still accepting bare printable runes. `textinput` always accumulates printable input unless the host rewrites keys. Keep the hand-written filter string and key switch.

### FilterInput stdin leak drop

After Bubble Tea parses keys, herdr can still leak C0 bytes from the prefix binding. The allowlist must keep Tab, LF, CR, ESC, Ctrl+K, and Ctrl+G. Bubble Tea supplies `WithFilter` only. Keep picker `FilterInput`.

### Choice list plus custom row

Choice collection appends a tagged `custom...` row that opens free text. `huh.Select` has no matching sentinel under the shared six-row ASCII list. Keep picker choice mode.

### Text prompt

The text prompt shares backtrack, collected answers, and ASCII submit hints with the picker queue. `huh.Input` is a separate form surface. Keep `promptValue`.

### Footer and position counter

`FormatListFooter` places the hint on the left and `index/total` on the right, clipping the hint first. Bubbles status and help views do not match that contract. Keep `tui.FormatListFooter`.

### Two-line detail wrap

`FormatDetailLines` wraps to two indented lines and truncates only the second. Lip Gloss has no matching helper. Keep the custom formatter.

### Inset muted horizontal rule

`FormatRule` indents by `RowTextIndent` and fills with ASCII dashes. Lip Gloss has no matching rule. Keep the custom formatter.

### Column row layout

Picker rows need cursor prefix, truncated title, warning mark, and right-aligned location. `ItemDelegate` can draw anything, yet ships no less product code for those columns. Keep `FormatPickerRowName` and the shared width helpers.

### ASCII-only chrome strings

Every chrome fragment must be single-column ASCII. Bubbles defaults are not that constraint. Keep `ChromeStrings` and the ASCII glyph tests.

### Terminal-column truncate

`x/ansi` measures and cuts cells. Product `Truncate` and `PadColumns` still own the ASCII ellipsis contract. Keep the wrappers.

### Theme warning versus muted

Indexed ANSI warn (3), muted (8), and reverse selection avoid OSC 4 palette queries. Lip Gloss styles colors but does not ship that theme. Keep `DefaultTheme`.

### Filter-row update indicator

The filter row may show `[run hwf update]` when width allows at least four filter cells. Bubbles `FilterInput` has no width-gated hint. Picker owns the row. TUI proves `Truncate` and `PadColumns` keep the ASCII indicator single-column.

### Palette body

Ctrl+K opens a letter-fire menu that restores the saved filter. No bubbles component matches that flow. Mechanism stays picker-owned.

### Delete confirm y/n

Delete mode accepts bare `y` / `n` / esc with `DeleteConfirmHint`. `huh.Confirm` does not match that chrome. Keep picker delete mode.

### Collected-answers truncation

Sequential inputs show `chosen: name=value` joined and truncated to content width. Bubbles has no helper. Keep `FormatInputAnswers` on `tui.Truncate`.

### Viewport height pad

After a shorter frame, Bubble Tea leaves prior TTY rows on screen. `PadHeight` appends blank lines up to the last frame height so ghost chrome does not linger. Keep the helper in `tui`.

### Runs detail scroll

Runs detail scrolls a fixed ASCII window over lines already wrapped for content width. `bubbles/v2` `viewport.Model` adds scrollbar, mouse, and soft-wrap behavior the product does not want. Keep `ScrollDetailLines` in the runs browser.
