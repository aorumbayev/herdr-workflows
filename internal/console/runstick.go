package console

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

// runsTickMsg carries the epoch that armed it. A tick from a stale epoch does
// not re-arm, so re-entering the runs screen never doubles the tick rate.
type runsTickMsg struct{ epoch int }

func runsTick(epoch int) tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg {
		return runsTickMsg{epoch: epoch}
	})
}

func (m Model) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// armRunsTick starts one ticker when a non-terminal run is visible and none runs yet.
func (m Model) armRunsTick() (Model, tea.Cmd) {
	if m.runsTicking || m.screen != screenRuns || !m.hasActiveRun() {
		return m, nil
	}
	m.runsEpoch++
	m.runsTicking = true
	return m, runsTick(m.runsEpoch)
}

func (m Model) handleRunsTick(epoch int) (tea.Model, tea.Cmd) {
	if epoch != m.runsEpoch || !m.runsTicking {
		return m, nil
	}
	if m.screen != screenRuns || !m.hasActiveRun() {
		m.runsTicking = false
		return m, nil
	}
	return m, runsTick(epoch)
}

func (m Model) hasActiveRun() bool {
	for _, item := range m.visibleRuns() {
		if !history.IsTerminal(item.Status) {
			return true
		}
	}
	return false
}
