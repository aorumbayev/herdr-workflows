package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func chooserPanes() []AgentPaneEntry {
	return []AgentPaneEntry{
		{PaneID: "w68:p1", Workspace: "ops", Tab: "claude › tickets", Kind: "claude", Status: "working", Title: "Intake interrogator", Self: true},
		{PaneID: "w6E:p5", Workspace: "herdr-workflows", Tab: "hwf-agent", Kind: "claude", Status: "done", Title: "Implementer persona setup"},
		{PaneID: "w6E:pT", Workspace: "herdr-workflows", Tab: "ponytail-cuts › claude", Kind: "claude", Status: "blocked", Title: "Subagent adversarial validation"},
		{PaneID: "w6E:pV", Workspace: "herdr-workflows", Tab: "ponytail-cuts › claude", Kind: "claude", Status: "unknown", Title: "reviewer"},
	}
}

func chooserRows(t *testing.T, panes []AgentPaneEntry, cursor, width int) []string {
	t.Helper()
	lines := strings.Split(ansi.Strip(FormatAgentPickBody(panes, cursor, width)), "\n")
	if len(lines) != len(panes)+1 {
		t.Fatalf("rows = %d, want %d:\n%s", len(lines)-1, len(panes), strings.Join(lines, "\n"))
	}
	return lines[1:]
}

func TestAgentPickBodyShowsLocationStatusAgentPaneIDAndSelfMarker(t *testing.T) {
	rows := chooserRows(t, chooserPanes(), 0, 100)
	if !strings.HasPrefix(rows[0], tui.CursorPrefix+"ops › claude › tickets") {
		t.Fatalf("row 0 must start with workspace › tab: %q", rows[0])
	}
	if !strings.Contains(rows[0], " * claude · Intake interrogator") {
		t.Fatalf("row 0 must show status, agent kind, and title: %q", rows[0])
	}
	if !strings.HasSuffix(rows[0], " w68:p1 (you)") {
		t.Fatalf("the caller's own pane shows its id then the marker: %q", rows[0])
	}
	if !strings.HasPrefix(rows[1], "  herdr-workflows › hwf-agent") || !strings.HasSuffix(rows[1], " w6E:p5") {
		t.Fatalf("row 1 = %q", rows[1])
	}
	if rows[2] == rows[3] || !strings.HasSuffix(rows[2], " w6E:pT") || !strings.HasSuffix(rows[3], " w6E:pV") {
		t.Fatalf("two agents in one tab must differ by pane id:\n%s\n%s", rows[2], rows[3])
	}
	if !strings.Contains(rows[2], "ponytail-cuts › claude") || !strings.Contains(rows[3], "ponytail-cuts › claude") {
		t.Fatalf("both same-tab rows carry the tab label:\n%s\n%s", rows[2], rows[3])
	}
}

func TestAgentPickBodyTruncatesLocationAndTitleNeverWraps(t *testing.T) {
	const width = 30
	rows := chooserRows(t, chooserPanes(), 0, width)
	for _, row := range rows {
		if tui.Columns(row) > width {
			t.Fatalf("row wider than %d: %q", width, row)
		}
	}
	if !strings.HasPrefix(rows[0], tui.CursorPrefix) || !strings.HasSuffix(rows[0], " w68:p1 (you)") {
		t.Fatalf("cursor, pane id, and the self marker must survive a narrow width: %q", rows[0])
	}
	if strings.Count(rows[2], tui.Ellipsis) < 1 {
		t.Fatalf("a long location or title must truncate: %q", rows[2])
	}
	for i, row := range rows {
		if !strings.Contains(row, " "+AgentStatusGlyph(chooserPanes()[i].Status)+" ") {
			t.Fatalf("the status glyph must survive a narrow width: %q", row)
		}
	}
}

func TestAgentPickBodyFallsBackWhenTheRecordCarriesNothing(t *testing.T) {
	rows := chooserRows(t, []AgentPaneEntry{{PaneID: "w1:p7"}}, 0, 40)
	if !strings.HasPrefix(rows[0], tui.CursorPrefix+"? ?") || !strings.HasSuffix(rows[0], " w1:p7") {
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
				{PaneID: "w1:p1", Workspace: "repo", Tab: "one", Status: "working", Title: "Alpha", Self: true},
				{PaneID: "w1:p2", Workspace: "repo", Tab: "two", Status: "blocked", Title: "Beta"},
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
	view := ansi.Strip(stripView(m.View()))
	if !strings.Contains(view, tui.AgentStatusLegend) {
		t.Fatalf("chooser footer must carry the legend:\n%s", view)
	}
	if !strings.Contains(view, "esc back") {
		t.Fatalf("the legend must sit beside the keys:\n%s", view)
	}
	if !strings.Contains(view, "repo › one * Alpha") || !strings.Contains(view, "w1:p1 (you)") {
		t.Fatalf("chooser rows = \n%s", view)
	}
	if !strings.Contains(view, "repo › two ! Beta") || !strings.Contains(view, "w1:p2") {
		t.Fatalf("chooser rows = \n%s", view)
	}
}
