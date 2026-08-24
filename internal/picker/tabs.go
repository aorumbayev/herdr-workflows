package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

type tabCell struct {
	name  string
	width int
}

func tabCells() []tabCell {
	names := []string{tui.TabWorkflows, tui.TabRuns, tui.TabConsole}
	out := make([]tabCell, len(names))
	for i, name := range names {
		out[i] = tabCell{name: name, width: len(name) + 2}
	}
	return out
}

// FormatTabBar paints the three picker root tabs. Active uses reverse. Inactive uses muted.
func FormatTabBar(active string, width int) string {
	theme := tui.DefaultTheme()
	parts := make([]string, 0, 3)
	for _, cell := range tabCells() {
		text := " " + cell.name + " "
		if cell.name == active {
			parts = append(parts, theme.Reverse.Render(text))
			continue
		}
		parts = append(parts, theme.Muted.Render(text))
	}
	bar := strings.Join(parts, " ")
	return tui.Truncate(bar, width)
}

// TabAtX returns the tab name under a content-column x, or empty.
func TabAtX(x int) string {
	pos := 0
	for _, cell := range tabCells() {
		if x >= pos && x < pos+cell.width {
			return cell.name
		}
		pos += cell.width + 1
	}
	return ""
}
