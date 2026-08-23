package picker

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestPaletteRenderIsPaletteOnly(t *testing.T) {
	// openspec/specs/picker-editor-actions/spec.md palette overlay
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "ctrl+k")
	body := m.View().Content
	if strings.Contains(body, "Chat handoff") || strings.Contains(body, "filter workflows") {
		t.Fatalf("palette must not ghost the workflow list:\n%s", body)
	}
	if !strings.Contains(body, "Create new") {
		t.Fatalf("palette body missing:\n%s", body)
	}
}

func TestInputClearsLeftoverListFilter(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md input prompts
	entry := workflow.WorkflowListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branchy"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"a", "b"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "b", "r", "a", "n", "c", "h")
	if m.filter != "branch" {
		t.Fatalf("filter = %q", m.filter)
	}
	m = apply(m, "enter")
	body := m.View().Content
	if strings.Contains(body, "\nbranch\n") || strings.HasPrefix(body, "branch") {
		t.Fatalf("input mode must not keep list filter text:\n%s", body)
	}
	if !strings.Contains(body, "unit") {
		t.Fatalf("prompt missing:\n%s", body)
	}
}

func TestFilterRowIsFlushLeftASCIIWithoutSlashPrefix(t *testing.T) {
	// Product Improvement: Charm flush-left ASCII filter. No OpenTUI "/ " prefix or indent.
	// openspec/specs/picker-presentation/spec.md "Picker chrome uses width-stable ASCII glyphs"
	m := New(Options{Entries: catalogEntries(), Width: 80})
	body := m.View().Content
	first := tui.StripContentPadding(strings.Split(body, "\n")[0])
	if strings.HasPrefix(first, "/ ") || strings.HasPrefix(first, "/") {
		t.Fatalf("filter must not use OpenTUI slash prefix: %q", first)
	}
	if first != tui.FilterWorkflows {
		t.Fatalf("empty filter row = %q want %q", first, tui.FilterWorkflows)
	}
	m = apply(m, "d")
	first = tui.StripContentPadding(strings.Split(m.View().Content, "\n")[0])
	if first != "d" {
		t.Fatalf("typed filter must be flush-left: %q", first)
	}
	for _, r := range first {
		if r > 127 {
			t.Fatalf("non-ASCII filter chrome: %q", first)
		}
	}
}

func TestPaletteViewPadsToWindowHeight(t *testing.T) {
	// Bubble Tea does not clear unused TTY lines. tmux capture-pane keeps prior-frame rows.
	const height = 24
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = applyMsg(m, tea.WindowSizeMsg{Width: 80, Height: height})
	m = apply(m, "ctrl+k")
	body := m.View().Content
	lines := strings.Split(body, "\n")
	if len(lines) < height {
		t.Fatalf("palette View lines = %d, want >= %d so leftover list rows cannot survive a naive capture:\n%s", len(lines), height, body)
	}
	if strings.Contains(body, tui.FilterWorkflows) || strings.Contains(body, "Branch check") {
		t.Fatalf("padded palette must not include list chrome:\n%s", body)
	}
}

func TestInputViewPadsToWindowHeight(t *testing.T) {
	const height = 24
	entry := workflow.WorkflowListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"a", "b"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = applyMsg(m, tea.WindowSizeMsg{Width: 80, Height: height})
	m = apply(m, "enter")
	body := m.View().Content
	lines := strings.Split(body, "\n")
	if len(lines) < height {
		t.Fatalf("input View lines = %d, want >= %d:\n%s", len(lines), height, body)
	}
	if strings.Contains(body, tui.FilterWorkflows) {
		t.Fatalf("padded input must not keep list filter:\n%s", body)
	}
}

func TestRunsPaneViewPadsToWindowHeight(t *testing.T) {
	const height = 24
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = applyMsg(m, tea.WindowSizeMsg{Width: 80, Height: height})
	m = apply(m, "tab")
	body := m.View().Content
	lines := strings.Split(body, "\n")
	if len(lines) < height {
		t.Fatalf("runs View lines = %d, want >= %d:\n%s", len(lines), height, body)
	}
	if strings.Contains(body, tui.FilterWorkflows) || strings.Contains(body, "Branch check") {
		t.Fatalf("padded runs must not ghost workflow list:\n%s", body)
	}
}
