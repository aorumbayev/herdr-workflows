package picker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestPickerFrameFitsPopupHeight(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, t.TempDir(), path)
	if err != nil {
		t.Fatal(err)
	}
	screens := []struct {
		name  string
		setup func(Model) Model
	}{
		{"workflows", func(m Model) Model { return m }},
		{"runs", func(m Model) Model { return apply(m, "tab") }},
		{"console", func(m Model) Model { return apply(m, "tab", "tab") }},
		{"console diagram", func(m Model) Model {
			m = apply(m, "tab", "tab")
			next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
			return next.(Model)
		}},
	}
	for _, height := range []int{15, 24, 40} {
		for _, sc := range screens {
			m := New(Options{
				Entries:      []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo", File: path}},
				Width:        100,
				Height:       height,
				LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) { return def, nil },
			})
			m = sc.setup(m)
			lines := strings.Count(m.View().Content, "\n") + 1
			if lines > height {
				t.Fatalf("screen=%s height=%d frame=%d lines\n%s", sc.name, height, lines, m.View().Content)
			}
		}
	}
}

func TestStatusLineDoesNotChangeFrameHeight(t *testing.T) {
	// A frame that changes line count makes bubbletea erase and redraw the
	// whole inline frame, which reads as a blink.
	m := New(Options{Entries: []workflow.ListEntry{{Name: "alpha", Title: "Alpha", Source: "repo"}}, Width: 64, Height: 15})
	quiet := strings.Count(m.View().Content, "\n")
	m.status = "validated alpha"
	busy := strings.Count(m.View().Content, "\n")
	if quiet != busy {
		t.Fatalf("frame height changed with the status line: %d then %d", quiet+1, busy+1)
	}
	if quiet+1 != 15 {
		t.Fatalf("frame = %d lines, want the popup height 15", quiet+1)
	}
}
