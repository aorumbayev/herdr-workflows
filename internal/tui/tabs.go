package tui

import "strings"

const (
	TabWorkflows = "workflows"
	TabRuns      = "runs"
	TabConsole   = "console"
)

// FormatTabBar paints the three picker root tabs. Active uses reverse. Inactive uses muted.
func FormatTabBar(active string, width int) string {
	theme := DefaultTheme()
	parts := make([]string, 0, 3)
	for _, name := range []string{TabWorkflows, TabRuns, TabConsole} {
		cell := " " + name + " "
		if name == active {
			parts = append(parts, theme.Reverse.Render(cell))
			continue
		}
		parts = append(parts, theme.Muted.Render(cell))
	}
	bar := strings.Join(parts, " ")
	return Truncate(bar, width)
}

// TabAtX returns the tab name under a content-column x, or empty.
func TabAtX(x int) string {
	names := []string{TabWorkflows, TabRuns, TabConsole}
	pos := 0
	for _, name := range names {
		cellW := len(name) + 2
		if x >= pos && x < pos+cellW {
			return name
		}
		pos += cellW + 1
	}
	return ""
}
