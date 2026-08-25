package runsbrowser

import (
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestRunsListSinglePositionCounter(t *testing.T) {
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
	// The runs pane has the same prior-frame row problem as the picker palette and the input views.
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

func TestRunRowStatusUsesIndexedSlotAndKeepsText(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha", "bravo")
	row := strings.Split(m.View().Content, "\n")[2]
	label := rowStatusToken(m.state.Items[0], 12)
	if !strings.Contains(ansi.Strip(row), label) {
		t.Fatalf("status text missing from %q", ansi.Strip(row))
	}
	want := "38;5;" + strconv.Itoa(tui.KindRunIndex) + "m" + label
	if !strings.Contains(row, want) {
		t.Fatalf("succeeded status must use ANSI %d: %q", tui.KindRunIndex, row)
	}
	if !strings.HasPrefix(strings.TrimPrefix(row, " "), "\x1b[7m") {
		t.Fatalf("cursor row must stay reverse across the painted status: %q", row)
	}
	if strings.Count(row, "\x1b[7") < 3 {
		t.Fatalf("reverse must re-open after the status reset: %q", row)
	}
}
