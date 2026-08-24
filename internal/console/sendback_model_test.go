package console

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
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
	for _, want := range []string{"Focus steps: brief", "Skill: hwf skills show herdr-workflow-create", "--- instruction ---", "fix"} {
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
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
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
	text, _ := renderRailYAML(d, nil, DiagramMarks{
		Focus:    railFocus{},
		Selected: map[string]bool{"brief": true},
	}, 80, 60, 0)
	if !strings.Contains(text, "[x]") || !strings.Contains(text, "brief") {
		t.Fatalf("marked diagram = %q", text)
	}
}

func TestModelDiagramSendbackChooserScrollsWindow(t *testing.T) {
	def := handoffDefinition(t)
	panes := make([]AgentPaneEntry, 8)
	for i := range panes {
		panes[i] = AgentPaneEntry{PaneID: fmt.Sprintf("p%d", i+1), Title: fmt.Sprintf("Agent%d", i+1)}
	}
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 10,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) { return panes, nil },
		PaneSendText:   func(paneID, text string) error { return nil },
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
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
	for range 7 {
		next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
		m = next.(Model)
	}
	view := stripView(m.View())
	if !strings.Contains(view, "Agent8") {
		t.Fatalf("cursor row scrolled out of view:\n%s", view)
	}
	if m.agentOffset == 0 {
		t.Fatal("agentOffset did not scroll")
	}
}

func spillOption(t *testing.T) (func(string, string) (string, string, error), *string) {
	t.Helper()
	spill := filepath.Join(t.TempDir(), "spill.txt")
	if err := os.WriteFile(spill, []byte("bundle"), 0o600); err != nil {
		t.Fatal(err)
	}
	return func(repoRoot, text string) (string, string, error) {
		return "read " + spill, spill, nil
	}, &spill
}

func TestModelDiagramSendbackCancelRemovesSpill(t *testing.T) {
	def := handoffDefinition(t)
	spillFn, spill := spillOption(t)
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{{PaneID: "p1"}, {PaneID: "p2"}}, nil
		},
		PaneSendText:  func(paneID, text string) error { return nil },
		SpillSendback: spillFn,
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
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
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(Model)
	if _, err := os.Stat(*spill); !os.IsNotExist(err) {
		t.Fatalf("spill file survived cancel: %v", err)
	}
}

func TestModelDiagramSendbackFailureRemovesSpill(t *testing.T) {
	def := handoffDefinition(t)
	spillFn, spill := spillOption(t)
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{{PaneID: "p1"}}, nil
		},
		PaneSendText:  func(paneID, text string) error { return errors.New("boom") },
		SpillSendback: spillFn,
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	next, _ = m.Update(keyRune('s'))
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if _, err := os.Stat(*spill); !os.IsNotExist(err) {
		t.Fatalf("spill file survived failed delivery: %v", err)
	}
	if !strings.Contains(stripView(m.View()), "send-back failed") {
		t.Fatalf("status = %q", stripView(m.View()))
	}
}

func TestModelDiagramSendbackSuccessKeepsSpill(t *testing.T) {
	def := handoffDefinition(t)
	spillFn, spill := spillOption(t)
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{{PaneID: "p1"}}, nil
		},
		PaneSendText:  func(paneID, text string) error { return nil },
		SpillSendback: spillFn,
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	next, _ = m.Update(keyRune('v'))
	m = next.(Model)
	next, _ = m.Update(keyRune('s'))
	m = next.(Model)
	_, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if _, err := os.Stat(*spill); err != nil {
		t.Fatalf("delivered spill file must survive for the typed pane: %v", err)
	}
}
