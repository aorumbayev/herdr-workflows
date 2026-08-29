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

// FormatTabBar centers the three picker root tabs in width. The active tab
// uses reverse. Inactive tabs use muted.
func FormatTabBar(active string, width int) string {
	theme := tui.DefaultTheme()
	parts := make([]string, 0, len(tabCells()))
	for _, cell := range tabCells() {
		text := " " + cell.name + " "
		if cell.name == active {
			parts = append(parts, theme.Reverse.Render(text))
			continue
		}
		parts = append(parts, theme.Muted.Render(text))
	}
	bar := strings.Repeat(" ", tabBarOffset(width)) + strings.Join(parts, " ")
	return tui.Truncate(bar, width)
}

// TabAtX gives the tab name at content-column x of a bar rendered in width,
// or an empty string.
func TabAtX(x, width int) string {
	pos := tabBarOffset(width)
	for _, cell := range tabCells() {
		if x >= pos && x < pos+cell.width {
			return cell.name
		}
		pos += cell.width + 1
	}
	return ""
}

// tabBarOffset is the left pad that centers the tab row in width.
func tabBarOffset(width int) int {
	row := tabRowWidth()
	if width <= row {
		return 0
	}
	return (width - row) / 2
}

func tabRowWidth() int {
	total := 0
	for i, cell := range tabCells() {
		if i > 0 {
			total++
		}
		total += cell.width
	}
	return total
}
