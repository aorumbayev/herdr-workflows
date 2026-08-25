package picker

import (
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// tabBodyHeight is the height that an embedded browser can use. The picker
// uses one row for the tab bar above it.
func (m Model) tabBodyHeight() int {
	return max(1, m.height-1)
}

func (m Model) cycleRootTab() (tea.Model, tea.Cmd) {
	switch m.mode {
	case modeList:
		return m.switchToTab(tui.TabRuns)
	case modeRuns:
		return m.switchToTab(tui.TabWorkflows)
	default:
		return m, nil
	}
}

func (m Model) openRunsTab() (tea.Model, tea.Cmd) {
	getenv := m.env
	if getenv == nil {
		getenv = os.Getenv
	}
	selected := ""
	if !m.restoreDetail {
		selected = m.restoreRunID
		m.restoreRunID = ""
	}
	m.runs = runsbrowser.New(runsbrowser.Options{
		RepoRoot:   m.repoRoot,
		Width:      m.width,
		Height:     m.tabBodyHeight(),
		Env:        getenv,
		SelectedID: selected,
	})
	m.mode = modeRuns
	m.hoverRow = -1
	if m.restoreDetail && m.restoreRunID != "" {
		id := m.restoreRunID
		m.restoreRunID = ""
		m.restoreDetail = false
		var cmd tea.Cmd
		m.runs, cmd = m.runs.OpenDetail(id)
		return m, cmd
	}
	return m, m.runs.Init()
}

func (m Model) switchToTab(name string) (tea.Model, tea.Cmd) {
	if name == m.currentTabName() {
		return m, nil
	}
	return m.mountTab(name)
}

// respawnInto opens the next tab in a popup of its own size and quits this one.
// herdr has no resize for a live popup, so the size moves with a new process.
func (m Model) respawnInto(tab string) (tea.Model, tea.Cmd) {
	return m.respawn(m.popupStateFor(tab))
}

func (m Model) respawn(state PopupState) (tea.Model, tea.Cmd) {
	if err := m.reopenPopup(state); err != nil {
		m.status = "popup resize failed" + tui.ChromeSep + err.Error()
		return m, nil
	}
	m.quit = true
	return m, tea.Quit
}

func (m Model) mountTab(name string) (tea.Model, tea.Cmd) {
	switch name {
	case tui.TabWorkflows:
		m.mode = modeList
		return m, nil
	case tui.TabRuns:
		return m.openRunsTab()
	default:
		return m, nil
	}
}
