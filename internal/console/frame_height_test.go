package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestConsoleFrameFitsTerminalHeight(t *testing.T) {
	id := "22222222-2222-4222-8222-222222222222"
	screens := []struct {
		name  string
		setup func(Model) Model
	}{
		{"workflows", func(m Model) Model { return m }},
		{"runs", func(m Model) Model {
			next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
			return next.(Model)
		}},
		{"detail", func(m Model) Model {
			next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
			m = next.(Model)
			next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
			return next.(Model)
		}},
		{"diagram", func(m Model) Model {
			next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
			return next.(Model)
		}},
		{"composer", func(m Model) Model {
			next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
			next, _ = next.(Model).Update(tea.KeyPressMsg{Code: 's', Text: "s"})
			return next.(Model)
		}},
	}
	for _, height := range []int{11, 24, 40} {
		for _, sc := range screens {
			m := New(Options{
				Entries: []workflow.ListEntry{
					{Name: "alpha", Title: "Alpha", Source: "repo"},
				},
				Width:  100,
				Height: height,
				LoadRuns: func() []history.Summary {
					return []history.Summary{{ID: id, Workflow: "alpha", Title: "Alpha", Status: "succeeded"}}
				},
				LoadDetail: func(runID string) DetailPayload {
					return DetailPayload{Workflow: "alpha", LogLines: []string{"ok"}}
				},
				LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
					return &workflow.Definition{Name: e.Name, Version: workflow.Format, Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}}}, nil
				},
			})
			m = sc.setup(m)
			lines := strings.Count(m.View().Content, "\n") + 1
			if lines > height {
				t.Fatalf("screen=%s height=%d frame=%d lines\n%s", sc.name, height, lines, m.View().Content)
			}
		}
	}
}
