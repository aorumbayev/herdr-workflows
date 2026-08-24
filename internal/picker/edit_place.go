package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const (
	EditorFileEnv = "HWF_EDITOR_FILE"
	EditorNameEnv = "HWF_EDITOR_NAME"
)

var editPlacementOptions = []string{"popup", "beside", "below", "tab"}

func formatEditPlacementBody(cursor int) string {
	lines := []string{"open editor placement"}
	for i, opt := range editPlacementOptions {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		if opt == "popup" {
			opt += " (default)"
		}
		lines = append(lines, prefix+opt)
	}
	return strings.Join(lines, "\n")
}

func (m Model) beginEditPlacement(entry *workflow.ListEntry) (tea.Model, tea.Cmd) {
	if entry == nil {
		m.mode = modeList
		m.filter = m.savedFilter
		return m, nil
	}
	m.editTarget = entry
	m.editPlaceCursor = 0
	m.placeBack = modeList
	m.filter = m.savedFilter
	m.mode = modeEditPlace
	m.status = ""
	return m, nil
}

func (m Model) handleEditPlace(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = m.placeBack
		m.editTarget = nil
		return m, nil
	case "up":
		if m.editPlaceCursor > 0 {
			m.editPlaceCursor--
		}
		return m, nil
	case "down":
		if m.editPlaceCursor+1 < len(editPlacementOptions) {
			m.editPlaceCursor++
		}
		return m, nil
	case "enter":
		entry := m.editTarget
		place := editPlacementOptions[m.editPlaceCursor]
		m.editTarget = nil
		if entry == nil {
			m.mode = m.placeBack
			return m, nil
		}
		if place == "popup" {
			m.mode = modeList
			if m.reopenPopup != nil && m.needsRespawn(tui.TabConsole) {
				return m.respawnForEdit(*entry)
			}
			return m, m.beginEdit(entry.File, entry.Name)
		}
		if m.openEditor != nil {
			if err := m.openEditor(entry.File, entry.Name, place); err != nil {
				m.mode = m.placeBack
				m.status = "editor open failed" + tui.ChromeSep + err.Error()
				if m.notify != nil {
					_ = m.notify("herdr-workflows", m.status)
				}
				return m, nil
			}
		}
		m.quit = true
		return m, tea.Quit
	}
	return m, nil
}

// respawnForEdit opens a console-sized popup, because a 64x15 popup is not
// large enough for $EDITOR. Validation then opens a compact popup.
func (m Model) respawnForEdit(entry workflow.ListEntry) (tea.Model, tea.Cmd) {
	return m.respawn(m.popupStateForEdit(entry))
}

func (m Model) renderEditPlace() string {
	w := m.contentWidth()
	body := formatEditPlacementBody(m.editPlaceCursor)
	footer := tui.FormatListFooter(w, m.editPlaceCursor, len(editPlacementOptions), "enter open"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}
