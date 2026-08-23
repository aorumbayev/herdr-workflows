package tui

import "charm.land/lipgloss/v2"

const (
	WarnIndex  = 3
	MutedIndex = 8
)

// Theme is indexed ANSI colors plus reverse-video selection (ticket 04 GAP 1).
type Theme struct {
	Warn    lipgloss.Style
	Muted   lipgloss.Style
	Reverse lipgloss.Style
}

// DefaultTheme uses terminal palette slots 3 and 8 and SGR reverse for selection.
func DefaultTheme() Theme {
	return Theme{
		Warn:    lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(WarnIndex)),
		Muted:   lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(MutedIndex)),
		Reverse: lipgloss.NewStyle().Reverse(true),
	}
}
