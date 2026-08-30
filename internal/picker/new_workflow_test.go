package picker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestNewWorkflowOffersAgentOrTemplate(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 24})
	m = apply(m, "ctrl+p", "n")
	if m.mode != modeNewMode {
		t.Fatalf("mode = %v, want new mode chooser", m.mode)
	}
	body := m.View().Content
	for _, want := range []string{"build with an agent", "edit a template"} {
		if !strings.Contains(body, want) {
			t.Fatalf("chooser missing %q:\n%s", want, body)
		}
	}
}

func TestNewWorkflowAgentNoPanesStatus(t *testing.T) {
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Height:  24,
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			return nil, nil
		},
	})
	m = apply(m, "ctrl+p", "n", "enter")
	if m.quit {
		t.Fatal("no agent panes must not quit the overlay")
	}
	if m.mode != modeNewMode {
		t.Fatalf("mode = %v, want new mode chooser", m.mode)
	}
	if !strings.Contains(m.status, "no agent panes open") {
		t.Fatalf("status = %q", m.status)
	}
}

func TestNewWorkflowAgentHandoffSendsPrompt(t *testing.T) {
	var sent string
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Height:  24,
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			return []console.AgentPaneEntry{{PaneID: "a1", Title: "Claude"}}, nil
		},
		PaneSendText: func(_, text string) error { sent = text; return nil },
		Notify:       func(string, ...string) error { return nil },
	})
	m = apply(m, "ctrl+p", "n", "enter")
	if !strings.Contains(sent, "herdr-workflow-create") {
		t.Fatalf("handoff must name the skill:\n%s", sent)
	}
	if !strings.Contains(strings.ToLower(sent), "grill") {
		t.Fatalf("handoff must ask the agent to grill first:\n%s", sent)
	}
	if !m.quit {
		t.Fatal("handoff must dismiss the overlay")
	}
}

func TestNewWorkflowAgentChooserNamesPanesAndExplainsGlyphs(t *testing.T) {
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Height:  24,
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			return []console.AgentPaneEntry{
				{PaneID: "w1:p1", Tab: "1", Status: "blocked", Title: "One", Self: true},
				{PaneID: "w1:p2", Tab: "2", Status: "done", Title: "Two"},
			}, nil
		},
		PaneSendText: func(string, string) error { return nil },
		Notify:       func(string, ...string) error { return nil },
	})
	m = apply(m, "ctrl+p", "n", "enter")
	body := m.View().Content
	for _, want := range []string{"1 ! One", "(you)", "2 - Two", "enter select", tui.AgentStatusLegend} {
		if !strings.Contains(body, want) {
			t.Fatalf("new-workflow chooser missing %q:\n%s", want, body)
		}
	}
}

func TestNewWorkflowTemplateRepoAndGlobal(t *testing.T) {
	repoRoot := t.TempDir()
	var edited []string
	repo := New(Options{
		Entries:  catalogEntries(),
		Width:    80,
		RepoRoot: repoRoot,
		EditWorkflow: func(_, name string) workflow.ValidateResult {
			edited = append(edited, name)
			return workflow.ValidateResult{OK: true}
		},
	})
	repo = apply(repo, "ctrl+p", "n", "down", "enter", "d", "e", "p", "enter")
	if repo.mode != modeNewScope {
		t.Fatalf("mode = %v, want scope chooser", repo.mode)
	}
	repo = apply(repo, "enter", "enter")
	if _, err := os.Stat(filepath.Join(repoRoot, ".hwf", "workflows", "dep.yaml")); err != nil {
		t.Fatalf("repo skeleton missing: %v", err)
	}
	if len(edited) != 1 || edited[0] != "dep" {
		t.Fatalf("repo edit = %v", edited)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	edited = nil
	global := New(Options{
		Entries:  catalogEntries(),
		Width:    80,
		RepoRoot: repoRoot,
		EditWorkflow: func(_, name string) workflow.ValidateResult {
			edited = append(edited, name)
			return workflow.ValidateResult{OK: true}
		},
	})
	global = apply(global, "ctrl+p", "n", "down", "enter", "d", "e", "p", "enter")
	if global.mode != modeNewScope {
		t.Fatalf("mode = %v, want scope chooser", global.mode)
	}
	global = apply(global, "down", "enter", "enter")
	if _, err := os.Stat(filepath.Join(home, ".hwf", "workflows", "dep.yaml")); err != nil {
		t.Fatalf("global skeleton missing: %v", err)
	}
	if len(edited) != 1 || edited[0] != "dep" {
		t.Fatalf("global edit = %v", edited)
	}
}

func TestNewWorkflowTemplatePopupResizes(t *testing.T) {
	repoRoot := t.TempDir()
	var states []PopupState
	m := New(Options{
		Entries:  catalogEntries(),
		Width:    80,
		RepoRoot: repoRoot,
		EditWorkflow: func(string, string) workflow.ValidateResult {
			t.Fatal("compact popup must not run the editor")
			return workflow.ValidateResult{}
		},
		ReopenPopup: func(state PopupState) error { states = append(states, state); return nil },
	})
	m = apply(m, "ctrl+p", "n", "down", "enter", "d", "e", "p", "enter", "enter", "enter")
	if !m.quit {
		t.Fatal("popup placement must quit the compact popup")
	}
	if len(states) != 1 {
		t.Fatalf("states = %v", states)
	}
	if states[0].Width != expandedWidth || states[0].Height != expandedHeight {
		t.Fatalf("new template popup opens expanded: %+v", states[0])
	}
	want := filepath.Join(repoRoot, ".hwf", "workflows", "dep.yaml")
	if states[0].EditFile != want {
		t.Fatalf("edit target = %q want %q", states[0].EditFile, want)
	}
}
