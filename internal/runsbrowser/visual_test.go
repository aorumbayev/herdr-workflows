package runsbrowser

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestRunsListSinglePositionCounter(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md Runs footer position
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha", "bravo")
	body := m.View().Content
	if strings.Count(body, "1/2") != 1 {
		t.Fatalf("expected one 1/2 counter, got:\n%s", body)
	}
	if !strings.Contains(body, tui.FilterRuns) {
		t.Fatalf("runs filter missing:\n%s", body)
	}
	if strings.Contains(body, "filter workflows") || strings.Contains(body, "Chat handoff") {
		t.Fatalf("runs view must not ghost workflow list:\n%s", body)
	}
}

func TestRunsViewPadsToWindowHeight(t *testing.T) {
	// The runs pane has the same leftover-line problem as the picker palette and input views.
	const height = 24
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha", "bravo")
	next, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: height})
	m = next.(Model)
	body := m.View().Content
	lines := strings.Split(body, "\n")
	if len(lines) < height {
		t.Fatalf("runs list View lines = %d, want >= %d:\n%s", len(lines), height, body)
	}
	m = apply(m, "enter")
	body = m.View().Content
	lines = strings.Split(body, "\n")
	if len(lines) < height {
		t.Fatalf("runs detail View lines = %d, want >= %d:\n%s", len(lines), height, body)
	}
}
