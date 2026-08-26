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
	names := []string{tui.TabWorkflows, tui.TabRuns, tui.TabProfiles}
	out := make([]tabCell, len(names))
	for i, name := range names {
		out[i] = tabCell{name: name, width: len(name) + 2}
	}
	return out
}

// FormatTabBar shows the key hint then the three picker root tabs. The active
// tab uses reverse. Inactive tabs and the key prefix use muted.
func FormatTabBar(active string, width int) string {
	theme := tui.DefaultTheme()
	parts := make([]string, 0, len(tabCells())+1)
	parts = append(parts, theme.Muted.Render(tui.TabKeyPrefix))
	for _, cell := range tabCells() {
		text := " " + cell.name + " "
		if cell.name == active {
			parts = append(parts, theme.Reverse.Render(text))
			continue
		}
		parts = append(parts, theme.Muted.Render(text))
	}
	bar := parts[0] + strings.Join(parts[1:], " ")
	return tui.Truncate(bar, width)
}

// TabAtX gives the tab name at content-column x, or an empty string. The tab
// labels begin after the key prefix.
func TabAtX(x int) string {
	pos := len(tui.TabKeyPrefix)
	for _, cell := range tabCells() {
		if x >= pos && x < pos+cell.width {
			return cell.name
		}
		pos += cell.width + 1
	}
	return ""
}
