package picker

import (
	tea "charm.land/bubbletea/v2"

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
	case fromFailed && detail.Status == "succeeded":
		m.runsSendbackStatus("nothing failed — r retries all steps")
		return m, nil
	}
	entry := m.entryNamed(detail.Workflow)
	if entry == nil {
		m.runsSendbackStatus("workflow " + detail.Workflow + " is not loadable in this checkout")
		return m, nil
	}
	m.detachLaunch()
	title := workflow.DisplayTitle(detail.Workflow, detail.Title)
	if title == "" {
		title = detail.Workflow
	}
	return m.startLaunch(title, FormatConsentLine(*entry), LaunchRunOpts{
		Name:       detail.Workflow,
		Inputs:     map[string]string{},
		RetryOf:    detail.ID,
		FromFailed: fromFailed,
	})
}

func (m Model) entryNamed(name string) *workflow.ListEntry {
	for i := range m.entries {
		if m.entries[i].Name == name && m.entries[i].Error == "" {
			return &m.entries[i]
		}
	}
	return nil
}
