package runsbrowser

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

// tickMsg carries the epoch that armed it. A tick from a stale epoch does not
// re-arm, so a reload never doubles the tick rate.
type tickMsg struct{ epoch int }

func tickCmd(epoch int) tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg {
		return tickMsg{epoch: epoch}
	})
}

func (m Model) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// armTick starts one ticker when a non-terminal run is visible and none runs yet.
func (m Model) armTick() (Model, tea.Cmd) {
	if m.ticking || !m.hasActiveRun() {
		return m, nil
	}
	m.tickEpoch++
	m.ticking = true
	return m, tickCmd(m.tickEpoch)
}

func (m Model) handleTick(epoch int) (Model, tea.Cmd) {
	if epoch != m.tickEpoch || !m.ticking {
		return m, nil
	}
	if !m.hasActiveRun() {
		m.ticking = false
		return m, nil
	}
	return m, tickCmd(epoch)
}

func (m Model) hasActiveRun() bool {
	if m.screen == screenDetail {
		return liveDetailTicks(m.detailView)
	}
	for _, item := range m.state.Items {
		if !history.IsTerminal(item.Status) {
			return true
		}
	}
	return false
}

func liveDetailTicks(view DetailView) bool {
	if view.Kind != "" && view.Kind != "detail" {
		return false
	}
	return view.Detail.StartedAt != "" && !history.IsTerminal(view.Detail.Status)
}
