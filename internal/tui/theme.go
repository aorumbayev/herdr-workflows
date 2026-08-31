package tui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// Indexed ANSI slots. Each value is a slot that the terminal theme of the user fills.
// Each color here repeats something that the text already says.
const (
	FailIndex         = 1
	KindRunIndex      = 2
	WarnIndex         = 3
	KindWorkflowIndex = 4
	KindHerdrIndex    = 5
	KindAgentIndex    = 6
	KindDefaultIndex  = 7
	PlaceholderIndex  = 8
)

// Theme is indexed ANSI colors plus reverse-video selection (ticket 04 GAP 1).
// Secondary chrome is faint, not a palette slot. Placeholder text takes indexed
// slot 8 alone. Faint on top of slot 8 renders too dark to read.
type Theme struct {
	Plain        lipgloss.Style
	Warn         lipgloss.Style
	Muted        lipgloss.Style
	Placeholder  lipgloss.Style
	Reverse      lipgloss.Style
	Hover        lipgloss.Style
	KindAgent    lipgloss.Style
	KindRun      lipgloss.Style
	KindHerdr    lipgloss.Style
	KindWorkflow lipgloss.Style
	KindDefault  lipgloss.Style
	Succeeded    lipgloss.Style
	Failed       lipgloss.Style
	Interrupted  lipgloss.Style
	Running      lipgloss.Style
	Stale        lipgloss.Style
}

// DefaultTheme uses terminal palette slots without OSC 4 queries.
func DefaultTheme() Theme {
	fg := func(index int) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(index))
	}
	return Theme{
		Plain:        lipgloss.NewStyle(),
		Warn:         fg(WarnIndex),
		Muted:        lipgloss.NewStyle().Faint(true),
		Placeholder:  fg(PlaceholderIndex),
		Reverse:      lipgloss.NewStyle().Reverse(true),
		Hover:        lipgloss.NewStyle().Underline(true),
		KindAgent:    fg(KindAgentIndex),
		KindRun:      fg(KindRunIndex),
		KindHerdr:    fg(KindHerdrIndex),
		KindWorkflow: fg(KindWorkflowIndex),
		KindDefault:  fg(KindDefaultIndex),
		Succeeded:    fg(KindRunIndex),
		Failed:       fg(FailIndex),
		Interrupted:  fg(WarnIndex),
		Running:      fg(KindAgentIndex),
		Stale:        lipgloss.NewStyle().Faint(true),
	}
}

// RunStatusStyle gives the locked ANSI slot for a run status token.
func (t Theme) RunStatusStyle(status string) lipgloss.Style {
	switch status {
	case "succeeded":
		return t.Succeeded
	case "failed":
		return t.Failed
	case "interrupted":
		return t.Interrupted
	case "running":
		return t.Running
	case "stale":
		return t.Stale
	default:
		return t.Muted
	}
}

// KindStyle gives the locked kind palette for a workflow step kind.
func (t Theme) KindStyle(kind string) lipgloss.Style {
	switch kind {
	case "agent":
		return t.KindAgent
	case "run":
		return t.KindRun
	case "herdr":
		return t.KindHerdr
	case "workflow":
		return t.KindWorkflow
	default:
		return t.KindDefault
	}
}

// MuteChrome shows secondary chrome faint. Content never uses this function.
func MuteChrome(text string) string {
	if text == "" {
		return ""
	}
	theme := DefaultTheme()
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if line != "" {
			lines[i] = theme.Muted.Render(line)
		}
	}
	return strings.Join(lines, "\n")
}
