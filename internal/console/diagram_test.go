package console

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestFormatDiagramHandoff(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, repoRoot, path)
	if err != nil {
		t.Fatal(err)
	}
	d := workflow.ProjectDiagram(*def)
	text, _ := renderRailYAML(d, tui.SplitStepYAML(string(body)), DiagramMarks{}, 120, 60, 0)
	for _, want := range []string{
		"brief",
		"agent",
		"pane: tab",
		"close: success",
		"notification.show",
		"pane: {{inputs.placement}}",
		"bg",
		"tab.close",
		"when:",
		"inputs.close_source",
		"inputs.placement",
		"pane.close",
		"!=",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("diagram missing %q:\n%s", want, text)
		}
	}
}

func handoffDefinition(t *testing.T) *workflow.Definition {
	t.Helper()
	repoRoot := t.TempDir()
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, repoRoot, path)
	if err != nil {
		t.Fatal(err)
	}
	return def
}

func TestModelWorkflowDiagramScreen(t *testing.T) {
	def := handoffDefinition(t)
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if m.screen != screenDiagram {
		t.Fatalf("screen = %d, want diagram", m.screen)
	}
	view := stripView(m.View())
	for _, want := range []string{"brief", "a insert", "s send-back"} {
		if !strings.Contains(view, want) {
			t.Fatalf("diagram view missing %q:\n%s", want, view)
		}
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(Model)
	if m.screen != screenWorkflows {
		t.Fatalf("screen = %d, want workflows", m.screen)
	}
}
