package picker

import (
	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func (m Model) beginRunsRetry(fromFailed bool) (tea.Model, tea.Cmd) {
	detail, ok := m.runs.DetailRun()
	switch {
	case !ok:
		m.runsSendbackStatus("retry needs a recorded run")
		return m, nil
	case detail.Status == "running":
		m.runsSendbackStatus("run is still running")
		return m, nil
	case detail.Status == "succeeded":
		m.runsSendbackStatus("successful runs cannot be retried")
		return m, nil
	}
	m.detachLaunch()
	title := workflow.DisplayTitle(detail.Workflow, detail.Title)
	if title == "" {
		title = detail.Workflow
	}
	return m.startLaunch(title, title+tui.ChromeSep+"saved workflow"+tui.ChromeSep+"repeats recorded actions", LaunchRunOpts{
		Name:       detail.Workflow,
		Inputs:     map[string]string{},
		RetryOf:    detail.ID,
		FromFailed: fromFailed,
	})
}
