package picker

import (
	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

const listBodyStartRow = 3

func (m Model) handleMouse(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.MouseClickMsg:
		return m.handleMouseClick(msg)
	case tea.MouseWheelMsg:
		return m.handleMouseWheel(msg)
	case tea.MouseMotionMsg:
		return m.handleMouseMotion(msg)
	default:
		return m, nil
	}
}

func (m Model) handleMouseClick(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	x, y := mouseContentXY(msg.X, msg.Y)
	if y == 0 && m.tabBarLive() {
		if tab := TabAtX(x, m.contentWidth()); tab != "" {
			return m.switchToTab(tab)
		}
	}
	if m.mode != modeList || msg.Button != tea.MouseLeft {
		return m, nil
	}
	if idx, ok := m.listIndexAt(y); ok {
		m.cursor = idx
		m.clampCursor()
		m.hoverRow = idx
	}
	return m, nil
}

func (m Model) handleMouseWheel(msg tea.MouseWheelMsg) (tea.Model, tea.Cmd) {
	if m.mode != modeList {
		return m, nil
	}
	switch msg.Button {
	case tea.MouseWheelUp:
		m.moveCursor(-1)
	case tea.MouseWheelDown:
		m.moveCursor(1)
	}
	return m, nil
}

func (m Model) handleMouseMotion(msg tea.MouseMotionMsg) (tea.Model, tea.Cmd) {
	if m.mode != modeList {
		return m, nil
	}
	_, y := mouseContentXY(msg.X, msg.Y)
	if idx, ok := m.listIndexAt(y); ok {
		m.hoverRow = idx
	} else {
		m.hoverRow = -1
	}
	return m, nil
}

func (m Model) listIndexAt(y int) (int, bool) {
	if y < listBodyStartRow {
		return 0, false
	}
	row := m.offset + (y - listBodyStartRow)
	n := len(m.matched())
	if row < 0 || row >= n || row >= m.offset+m.listViewport() {
		return 0, false
	}
	return row, true
}

// tabBarLive is true when Tab can cycle root browsers. A pointer must not
// leave a screen that the keyboard cannot leave.
func (m Model) tabBarLive() bool {
	switch m.mode {
	case modeList, modeProfiles:
		return true
	case modeRuns:
		return m.runs.IsList()
	default:
		return false
	}
}

func mouseContentXY(x, y int) (int, int) {
	return x - tui.ChromePaddingX, y
}
