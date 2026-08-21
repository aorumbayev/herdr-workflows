package tui

import (
	"strconv"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// Ellipsis is the ASCII truncation marker used in picker chrome.
const Ellipsis = "..."

// RowTextIndent is the Select name indent (contentX + 1 with indicator off).
const RowTextIndent = 3

// Columns returns the terminal cell width of s.
func Columns(s string) int {
	return ansi.StringWidth(s)
}

// Truncate shortens s to max cells, appending Ellipsis when it does not fit.
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

// PadColumns right-pads s with spaces to width cells.
func PadColumns(s string, width int) string {
	used := Columns(s)
	if used >= width {
		return s
	}
	return s + strings.Repeat(" ", width-used)
}

// PadHeight adds blank lines until a naive line split of s has at least height lines.
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
	space := strings.LastIndex(window, " ")
	if space > 0 {
		return window[:space]
	}
	return window
}

// FormatDetailLines wraps a description onto at most two indented lines.
func FormatDetailLines(description string, contentWidth int) string {
	text := strings.Join(strings.Fields(description), " ")
	if text == "" {
		return ""
	}
	indent := strings.Repeat(" ", RowTextIndent)
	budget := max(0, contentWidth-RowTextIndent)
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

// FormatRule draws a muted horizontal rule under the list, inset by RowTextIndent.
func FormatRule(contentWidth int) string {
	field := max(0, contentWidth-RowTextIndent)
	return strings.Repeat(" ", RowTextIndent) + strings.Repeat("-", field)
}

// FormatListFooter places hint on the left and index/total on the right.
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
