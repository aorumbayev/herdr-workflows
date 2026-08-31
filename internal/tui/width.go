package tui

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Ellipsis is the ASCII truncation marker used in picker chrome.
const Ellipsis = "..."

// RowTextIndent is the list-row text indent (cursor prefix plus one space).
const RowTextIndent = 3

// ChromePaddingX is the one-cell left and right inset inside the popup border.
const ChromePaddingX = 1

// DetailBlockHeight is the fixed two-row detail area under the list.
const DetailBlockHeight = 2

// ColumnGutter is the space between the title and warning columns.
const ColumnGutter = 2

// WarningWidth is the single-cell warning marker column.
const WarningWidth = 1

// LocationWidth is the location column aligned on the right.
const LocationWidth = 7

// Columns gives the terminal cell width of s.
func Columns(s string) int {
	return ansi.StringWidth(s)
}

// Truncate shortens s to max cells and adds Ellipsis when it does not fit.
func Truncate(s string, max int) string {
	if Columns(s) <= max {
		return s
	}
	if max <= 0 {
		return ""
	}
	ellipsisCols := Columns(Ellipsis)
	if max < ellipsisCols {
		return ansi.Cut(Ellipsis, 0, max)
	}
	return ansi.Truncate(s, max, Ellipsis)
}

// TruncateStart shortens s to max cells and adds Ellipsis on the left, so the
// tail the user is typing stays visible.
func TruncateStart(s string, max int) string {
	used := Columns(s)
	if used <= max {
		return s
	}
	if max <= 0 {
		return ""
	}
	ellipsisCols := Columns(Ellipsis)
	if max < ellipsisCols {
		return ansi.Cut(Ellipsis, 0, max)
	}
	start := used - (max - ellipsisCols)
	for start <= used {
		got := Ellipsis + ansi.Cut(s, start, used)
		if Columns(got) <= max {
			return got
		}
		start++
	}
	return ansi.Cut(Ellipsis, 0, max)
}

// FormatField renders a free-text field value after a fixed FieldCursor at column
// zero. The text starts at RowTextIndent, in register with list row titles.
// A long value keeps its tail, so the newest characters stay visible.
func FormatField(value, placeholder string, width int) string {
	prefix := FieldCursor + strings.Repeat(" ", RowTextIndent-Columns(FieldCursor))
	room := max(0, width-Columns(prefix))
	if room == 0 {
		return FieldCursor
	}
	if value != "" {
		return prefix + TruncateStart(value, room)
	}
	if placeholder == "" {
		return FieldCursor
	}
	return prefix + DefaultTheme().Placeholder.Render(Truncate(placeholder, room))
}

// FormatFieldEdge draws the edge under a free-text field, flush left and wide as
// width. The glyph is the lipgloss ASCII bottom border, so the edge and FormatRule
// stay one system.
func FormatFieldEdge(width int) string {
	return strings.Repeat(lipgloss.ASCIIBorder().Bottom, max(0, width))
}

// PadColumns adds spaces on the right of s until the width in cells.
func PadColumns(s string, width int) string {
	used := Columns(s)
	if used >= width {
		return s
	}
	return s + strings.Repeat(" ", width-used)
}

// PadHeight adds blank lines until a line split of s has at least height lines.
// Bubble Tea does not clear unused TTY rows. The pad stops prior-frame ghost rows.
func PadHeight(s string, height int) string {
	if height <= 0 {
		return s
	}
	n := strings.Count(s, "\n") + 1
	if n >= height {
		return s
	}
	return s + strings.Repeat("\n", height-n)
}

// ListViewport is the six-row floor shared by picker and runs browser.
const ListViewport = 6

// FitViewport gives a scrolling body the unused chrome rows, never fewer than min.
// An unknown height uses min.
func FitViewport(height, chrome, min int) int {
	if height <= 0 {
		return min
	}
	return max(min, height-chrome)
}

// ContentWidth is the inner chrome width for a popup of the given terminal columns.
func ContentWidth(width int) int {
	if width <= 2*ChromePaddingX {
		return 0
	}
	return width - 2*ChromePaddingX
}

// PadContent adds one-cell horizontal padding on every line.
func PadContent(body string, contentWidth int) string {
	if body == "" {
		return ""
	}
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		lines[i] = PadContentLine(line, contentWidth)
	}
	return strings.Join(lines, "\n")
}

// PadContentLine pads one rendered line to the full terminal width.
func PadContentLine(line string, contentWidth int) string {
	inner := PadColumns(Truncate(line, contentWidth), contentWidth)
	return strings.Repeat(" ", ChromePaddingX) + inner + strings.Repeat(" ", ChromePaddingX)
}

// StripChromePadding removes only the one-cell popup inset from a rendered line.
func StripChromePadding(line string) string {
	pad := strings.Repeat(" ", ChromePaddingX)
	if strings.HasPrefix(line, pad) {
		line = line[ChromePaddingX:]
	}
	if strings.HasSuffix(line, pad) {
		line = line[:len(line)-ChromePaddingX]
	}
	return line
}

// StripContentPadding removes popup inset and line-fill spaces that PadContentLine adds.
func StripContentPadding(line string) string {
	return strings.TrimRight(StripChromePadding(line), " ")
}

// ClampListWindow keeps cursor in [0, n) and moves offset so the cursor stays
// visible in a viewport-tall window. Empty lists set both to 0.
func ClampListWindow(cursor, offset, n, viewport int) (int, int) {
	if n <= 0 {
		return 0, 0
	}
	if cursor >= n {
		cursor = n - 1
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor < offset {
		offset = cursor
	}
	if cursor >= offset+viewport {
		offset = cursor - viewport + 1
	}
	return cursor, offset
}

func takeColumns(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if Columns(s) <= max {
		return s
	}
	return ansi.Cut(s, 0, max)
}

func takeWrappedLine(text string, budget int) string {
	if Columns(text) <= budget {
		return text
	}
	window := takeColumns(text, budget)
	if window == "" {
		_, size := utf8.DecodeRuneInString(text)
		return text[:size]
	}
	space := strings.LastIndex(window, " ")
	if space > 0 {
		return window[:space]
	}
	return window
}

// WrapIndented breaks text on word boundaries into rows indented by RowTextIndent,
// so continuations hang under the first row instead of the left edge.
func WrapIndented(text string, contentWidth int) []string {
	indent := strings.Repeat(" ", RowTextIndent)
	budget := max(1, contentWidth-RowTextIndent)
	var out []string
	for {
		line := takeWrappedLine(text, budget)
		out = append(out, indent+line)
		text = strings.TrimLeft(text[len(line):], " ")
		if text == "" {
			return out
		}
	}
}

// FormatDetailBlock puts detail text on two fixed rows.
func FormatDetailBlock(description string, contentWidth int) string {
	detail := FormatDetailLines(description, contentWidth)
	lines := strings.Split(detail, "\n")
	for len(lines) < DetailBlockHeight {
		lines = append(lines, "")
	}
	if len(lines) > DetailBlockHeight {
		lines = lines[:DetailBlockHeight]
	}
	return strings.Join(lines, "\n")
}

// FormatDetailLines puts a description on two indented lines or fewer.
func FormatDetailLines(description string, contentWidth int) string {
	text := strings.Join(strings.Fields(description), " ")
	if text == "" {
		return ""
	}
	indent := strings.Repeat(" ", RowTextIndent)
	budget := max(0, contentWidth-RowTextIndent-RowRightGutter)
	line1 := takeWrappedLine(text, budget)
	rest := strings.TrimLeft(text[len(line1):], " \t")
	if rest == "" {
		return indent + line1
	}
	line2 := rest
	if Columns(rest) > budget {
		line2 = Truncate(rest, budget)
	}
	return indent + line1 + "\n" + indent + line2
}

// FormatRule shows a muted horizontal rule under the list, inset on both sides.
func FormatRule(contentWidth int) string {
	field := max(0, contentWidth-2*RowTextIndent)
	return strings.Repeat(" ", RowTextIndent) + strings.Repeat("-", field) + strings.Repeat(" ", RowTextIndent)
}

// FormatListFooter puts hint on the left and index/total on the right.
func FormatListFooter(contentWidth, selectedIndex, total int, hint string) string {
	if total == 0 {
		return Truncate(hint, contentWidth)
	}
	counter := formatCounter(selectedIndex+1, total)
	hintCols := Columns(hint)
	counterCols := Columns(counter)
	if hintCols+1+counterCols <= contentWidth {
		pad := contentWidth - hintCols - counterCols
		return hint + strings.Repeat(" ", pad) + counter
	}
	clipped := Truncate(hint, max(0, contentWidth-counterCols-1))
	pad := max(0, contentWidth-Columns(clipped)-counterCols)
	return clipped + strings.Repeat(" ", pad) + counter
}

func formatCounter(index, total int) string {
	return strconv.Itoa(index) + "/" + strconv.Itoa(total)
}
