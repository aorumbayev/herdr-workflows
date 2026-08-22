package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestModelDiagramSendbackSingleAgent(t *testing.T) {
	def := handoffDefinition(t)
	var sentPane, sentText string
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.WorkflowListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{{PaneID: "agent-1", Title: "Claude"}}, nil
		},
		PaneSendText: func(paneID, text string) error {
			sentPane = paneID
			sentText = text
			return nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	if m.diagramMode != diagramModeSelect {
		t.Fatalf("mode = %d, want select", m.diagramMode)
	}
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	if !m.diagramSelected["brief"] {
		t.Fatal("brief not selected")
	}
	next, _ = m.Update(keyRune('s'))
	m = next.(Model)
	if m.diagramMode != diagramModeInstruction {
		t.Fatalf("mode = %d, want instruction", m.diagramMode)
	}
	next, _ = m.Update(keyRune('f'))
	m = next.(Model)
	next, _ = m.Update(keyRune('i'))
	m = next.(Model)
	next, _ = m.Update(keyRune('x'))
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if sentPane != "agent-1" {
		t.Fatalf("sent pane = %q", sentPane)
	}
	for _, want := range []string{"Selected steps: brief", "id: brief", "--- instruction ---", "fix"} {
		if !strings.Contains(sentText, want) {
			t.Fatalf("sent text missing %q:\n%s", want, sentText)
		}
	}
	if strings.Contains(sentText, "agent.prompt") {
		t.Fatal("must not auto-submit via agent.prompt")
	}
	view := stripView(m.View())
	if !strings.Contains(view, "typed annotation") {
		t.Fatalf("status = %q", view)
	}
}

func TestModelDiagramSendbackAgentChooser(t *testing.T) {
	def := handoffDefinition(t)
	var sentPane string
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.WorkflowListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{
				{PaneID: "p1", Title: "Alpha"},
				{PaneID: "p2", Title: "Beta"},
			}, nil
		},
		PaneSendText: func(paneID, text string) error {
			sentPane = paneID
			return nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	next, _ = m.Update(keyRune('s'))
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if m.diagramMode != diagramModeAgentPick {
		t.Fatalf("mode = %d, want agent pick", m.diagramMode)
	}
	view := stripView(m.View())
	if !strings.Contains(view, "Alpha") || !strings.Contains(view, "Beta") {
		t.Fatalf("chooser view = %q", view)
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if sentPane != "p2" {
		t.Fatalf("sent pane = %q, want p2", sentPane)
	}
}

func TestFormatDiagramMarksSelection(t *testing.T) {
	def := handoffDefinition(t)
	d := workflow.ProjectDiagram(*def)
	text := FormatDiagramWithMarks(d, DiagramMarks{
		SelectMode: true,
		FocusIndex: 0,
		Selected:   map[string]bool{"brief": true},
	}, 80)
	if !strings.Contains(text, "> [x] brief") {
		t.Fatalf("marked diagram = %q", text)
	}
}
