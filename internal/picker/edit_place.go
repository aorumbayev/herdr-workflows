package picker

import (
	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

const (
	EditorFileEnv = "HWF_EDITOR_FILE"
	EditorNameEnv = "HWF_EDITOR_NAME"
)

var editPlacementOptions = []string{"popup", "beside", "below", "tab"}

func formatEditPlacementBody(cursor int) string {
	labels := make([]string, len(editPlacementOptions))
	for i, opt := range editPlacementOptions {
		labels[i] = opt
		if opt == "popup" {
			labels[i] += " (default)"
		}
	}
	return formatChooserBody("open editor placement", labels, cursor)
}

func (m Model) beginEditPlacement(path, name string, isProfile bool, back mode) (tea.Model, tea.Cmd) {
	if path == "" {
		m.mode = back
		return m, nil
	}
	m.editPath = path
	m.editName = name
	m.editProfile = isProfile
	m.editPlaceCursor = 0
	m.placeBack = back
	if !isProfile {
		m.filter = m.savedFilter
	}
	m.mode = modeEditPlace
	m.status = ""
	return m, nil
}

func (m Model) handleEditPlace(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = m.placeBack
		m.editPath, m.editName = "", ""
		return m, nil
	case "up":
		m.editPlaceCursor = tui.StepCursor(m.editPlaceCursor, -1, len(editPlacementOptions))
		return m, nil
	case "down":
		m.editPlaceCursor = tui.StepCursor(m.editPlaceCursor, 1, len(editPlacementOptions))
		return m, nil
	case "enter":
		path, name := m.editPath, m.editName
		place := editPlacementOptions[m.editPlaceCursor]
		if path == "" {
			m.mode = m.placeBack
			return m, nil
		}
		if place == "popup" {
			m.mode = m.landingModeForEdit()
			if m.reopenPopup != nil && m.needsExpandedRespawn() {
				return m.respawnForEdit()
			}
			return m, m.beginEdit(path, name)
		}
		m.editPath, m.editName = "", ""
		if m.openEditor != nil {
			if err := m.openEditor(path, name, place); err != nil {
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

func (m Model) landingModeForEdit() mode {
	if m.editProfile {
		return modeProfiles
	}
	return modeList
}

// respawnForEdit opens a console-sized popup, because a 64x15 popup is not
// large enough for $EDITOR. Validation then opens a compact popup.
func (m Model) respawnForEdit() (tea.Model, tea.Cmd) {
	return m.respawn(m.popupStateForEdit())
}

func (m Model) renderEditPlace() string {
	w := m.contentWidth()
	body := formatEditPlacementBody(m.editPlaceCursor)
	footer := tui.FormatListFooter(w, m.editPlaceCursor, len(editPlacementOptions), "enter open"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}
