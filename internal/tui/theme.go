package tui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// Indexed ANSI slots. Every one is a slot the user's own terminal theme fills,
// and every color here repeats something the text already says.
const (
	FailIndex         = 1
	KindRunIndex      = 2
	WarnIndex         = 3
	KindWorkflowIndex = 4
	KindHerdrIndex    = 5
	KindAgentIndex    = 6
	KindDefaultIndex  = 7
)

// Theme is indexed ANSI colors plus reverse-video selection (ticket 04 GAP 1).
// Secondary text is faint rather than a palette slot: faint derives from the
// user's own foreground, and a terminal that drops it leaves readable text.
type Theme struct {
	Plain        lipgloss.Style
	Warn         lipgloss.Style
	Muted        lipgloss.Style
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

// RunStatusStyle maps a run status token to its locked ANSI slot.
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

// KindStyle maps a workflow step kind onto the locked kind palette.
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

// MuteChrome paints secondary chrome faint. Content never passes through here.
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
