package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

var consolePlacementOptions = []console.Placement{
	console.PlacementBeside,
	console.PlacementBelow,
	console.PlacementTab,
}

func consolePlacementLabel(p console.Placement) string {
	if p == console.PlacementTab {
		return "new tab"
	}
	return string(p)
}

func formatConsolePlacementBody(cursor int, remembered console.Placement) string {
	var lines []string
	lines = append(lines, "open console placement")
	for i, p := range consolePlacementOptions {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		label := consolePlacementLabel(p)
		if p == remembered {
			label += " (default)"
		}
		lines = append(lines, prefix+label)
	}
	return strings.Join(lines, "\n")
}

func (m Model) rememberedPlacement() console.Placement {
	if m.lastConsolePlacement == "" {
		return console.DefaultPlacement
	}
	return m.lastConsolePlacement
}

func (m Model) beginConsolePlacement(back mode) (tea.Model, tea.Cmd) {
	m.placeBack = back
	m.mode = modeConsolePlace
	m.status = ""
	remembered := m.rememberedPlacement()
	m.consolePlaceCursor = 0
	for i, p := range consolePlacementOptions {
		if p == remembered {
			m.consolePlaceCursor = i
			break
		}
	}
	return m, nil
}

func (m Model) handleConsolePlace(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = m.placeBack
		return m, nil
	case "up":
		if m.consolePlaceCursor > 0 {
			m.consolePlaceCursor--
		}
		return m, nil
	case "down":
		if m.consolePlaceCursor+1 < len(consolePlacementOptions) {
			m.consolePlaceCursor++
		}
		return m, nil
	case "enter":
		placement := consolePlacementOptions[m.consolePlaceCursor]
		if m.openConsole != nil {
			if err := m.openConsole(placement, m.consoleLandingWorkflow()); err != nil {
				m.mode = m.placeBack
				m.status = consoleOpenStatus(err)
				return m, nil
			}
		}
		m.lastConsolePlacement = placement
		m.quit = true
		return m, tea.Quit
	}
	return m, nil
}

// consoleLandingWorkflow gives the selected workflow name when the chooser was
// opened from the workflows list, so the console pane lands on its diagram.
func (m Model) consoleLandingWorkflow() string {
	if m.placeBack != modeList {
		return ""
	}
	if e := m.selectedEntry(); e != nil && e.Error == "" {
		return e.Name
	}
	return ""
}

func (m Model) renderConsolePlace() string {
	w := m.contentWidth()
	body := formatConsolePlacementBody(m.consolePlaceCursor, m.rememberedPlacement())
	footer := tui.FormatListFooter(w, m.consolePlaceCursor, len(consolePlacementOptions), "enter open"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}

func consoleOpenStatus(err error) string {
	if host.IsTransportLoss(err) {
		return "console pane unavailable — is this running inside herdr?"
	}
	return "console pane failed" + tui.ChromeSep + err.Error()
}
