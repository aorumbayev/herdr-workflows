package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

var consolePlacementOptions = []console.Placement{
	console.PlacementBeside,
	console.PlacementTab,
	console.PlacementBelow,
}

func FormatConsolePlacementBody(cursor int, remembered console.Placement) string {
	var lines []string
	lines = append(lines, "open console placement")
	for i, p := range consolePlacementOptions {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		label := string(p)
		if p == remembered || (remembered == "" && p == console.DefaultPlacement) {
			label += " (default)"
		}
		lines = append(lines, prefix+label)
	}
	return strings.Join(lines, "\n")
}

func (m Model) beginConsolePlacement() (tea.Model, tea.Cmd) {
	m.mode = modeConsolePlace
	m.filter = m.savedFilter
	m.status = ""
	remembered := m.lastConsolePlacement
	if remembered == "" {
		remembered = console.DefaultPlacement
	}
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
		m.mode = modeList
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
		m.lastConsolePlacement = placement
		if m.openConsole != nil {
			if err := m.openConsole(placement); err != nil {
				m.mode = modeList
				m.status = "console open failed" + tui.ChromeSep + err.Error()
				return m, nil
			}
		}
		m.quit = true
		return m, tea.Quit
	}
	return m, nil
}

func (m Model) renderConsolePlace() string {
	remembered := m.lastConsolePlacement
	if remembered == "" {
		remembered = console.DefaultPlacement
	}
	w := m.contentWidth()
	body := FormatConsolePlacementBody(m.consolePlaceCursor, remembered)
	footer := tui.FormatListFooter(w, m.consolePlaceCursor, len(consolePlacementOptions), "enter open"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}
