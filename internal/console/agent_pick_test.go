package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func chooserPanes() []AgentPaneEntry {
	return []AgentPaneEntry{
		{PaneID: "w5Z:p1", Tab: "1", Kind: "claude", Status: "working", Title: "Intake interrogator", Self: true},
		{PaneID: "w5Z:p3", Tab: "2", Kind: "claude", Status: "done", Title: "Picker popup dismiss and tab bar center"},
		{PaneID: "w5Z:p9", Tab: "10", Kind: "claude", Status: "blocked", Title: "Reviewer persona"},
		{PaneID: "w5Z:p11", Tab: "11", Status: "unknown", Title: "w5Z:p11"},
	}
}

func chooserRows(t *testing.T, panes []AgentPaneEntry, cursor, width int) []string {
	t.Helper()
	lines := strings.Split(FormatAgentPickBody(panes, cursor, width), "\n")
	if len(lines) != len(panes)+1 {
		t.Fatalf("rows = %d, want %d:\n%s", len(lines)-1, len(panes), strings.Join(lines, "\n"))
	}
	return lines[1:]
}

func TestAgentPickBodyShowsTabStatusTitleAndSelfMarker(t *testing.T) {
	rows := chooserRows(t, chooserPanes(), 0, 58)
	if !strings.HasPrefix(rows[0], tui.CursorPrefix+"1  * Intake interrogator") {
		t.Fatalf("row 0 = %q", rows[0])
	}
	if !strings.HasSuffix(rows[0], " (you)") {
		t.Fatalf("the caller's own pane must be marked: %q", rows[0])
	}
	if !strings.HasPrefix(rows[1], "  2  - Picker popup dismiss") || strings.Contains(rows[1], "(you)") {
		t.Fatalf("row 1 = %q", rows[1])
	}
	if !strings.HasPrefix(rows[2], "  10 ! Reviewer persona") {
		t.Fatalf("a wider tab number must not shift the title column: %q", rows[2])
	}
	if !strings.HasPrefix(rows[3], "  11 ? w5Z:p11") {
		t.Fatalf("row 3 = %q", rows[3])
	}
	for _, row := range rows {
		if strings.Contains(row, "w5Z:p1 ") || strings.Contains(row, "w5Z:p3") || strings.Contains(row, "w5Z:p9") {
			t.Fatalf("a pane with a title must not show its raw pane id: %q", row)
		}
	}
}

func TestAgentPickBodyTruncatesOnlyTheTitle(t *testing.T) {
	const width = 30
	rows := chooserRows(t, chooserPanes(), 0, width)
	for _, row := range rows {
		if tui.Columns(row) > width {
			t.Fatalf("row wider than %d: %q", width, row)
		}
	}
	if !strings.HasPrefix(rows[0], tui.CursorPrefix+"1  * ") || !strings.HasSuffix(rows[0], " (you)") {
		t.Fatalf("tab, status, and the self marker must survive a narrow width: %q", rows[0])
	}
	if !strings.Contains(rows[0], tui.Ellipsis) {
		t.Fatalf("the title must be the part that truncates: %q", rows[0])
	}
	if !strings.HasPrefix(rows[2], "  10 ! ") {
		t.Fatalf("row 2 = %q", rows[2])
	}
}

func TestAgentPickBodyFallsBackWhenTheRecordCarriesNothing(t *testing.T) {
	rows := chooserRows(t, []AgentPaneEntry{{PaneID: "w1:p7"}}, 0, 40)
	if !strings.HasPrefix(rows[0], tui.CursorPrefix+"? ? w1:p7") {
		t.Fatalf("an empty record must still name the pane: %q", rows[0])
	}
}

func TestAgentStatusGlyphsAreSingleColumnASCII(t *testing.T) {
	want := map[string]string{
		"working": "*", "idle": "-", "done": "-", "blocked": "!", "unknown": "?", "": "?",
	}
	for status, glyph := range want {
		if got := AgentStatusGlyph(status); got != glyph {
			t.Fatalf("glyph(%q) = %q, want %q", status, got, glyph)
		}
	}
	for _, glyph := range want {
		if tui.Columns(glyph) != 1 {
			t.Fatalf("glyph %q is not single-column", glyph)
		}
	}
	for _, token := range []string{"*", "-", "!"} {
		if !strings.Contains(tui.AgentStatusLegend, token) {
			t.Fatalf("legend %q must name %q", tui.AgentStatusLegend, token)
		}
	}
}

func TestAgentPickFooterCarriesTheStatusLegend(t *testing.T) {
	def := handoffDefinition(t)
	m := New(Options{
		RepoRoot:     t.TempDir(),
		Entries:      []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo"}},
		Width:        120,
		Height:       24,
		LoadWorkflow: func(workflow.ListEntry) (*workflow.Definition, error) { return def, nil },
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{
				{PaneID: "w1:p1", Tab: "1", Status: "working", Title: "Alpha", Self: true},
				{PaneID: "w1:p2", Tab: "2", Status: "blocked", Title: "Beta"},
			}, nil
		},
		PaneSendText: func(string, string) error { return nil },
	})
	for _, msg := range []tea.KeyPressMsg{{Code: tea.KeyEnter}, keyRune('v'), keyRune('s'), {Code: tea.KeyEnter}} {
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	if m.diagramMode != diagramModeAgentPick {
		t.Fatalf("mode = %d, want agent pick", m.diagramMode)
	}
	view := stripView(m.View())
	if !strings.Contains(view, tui.AgentStatusLegend) {
		t.Fatalf("chooser footer must carry the legend:\n%s", view)
	}
	if !strings.Contains(view, "esc back") {
		t.Fatalf("the legend must sit beside the keys:\n%s", view)
	}
	if !strings.Contains(view, "1 * Alpha") || !strings.Contains(view, "(you)") {
		t.Fatalf("chooser rows = \n%s", view)
	}
	if !strings.Contains(view, "2 ! Beta") {
		t.Fatalf("chooser rows = \n%s", view)
	}
}
